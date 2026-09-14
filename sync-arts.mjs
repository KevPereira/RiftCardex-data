// Sauvegarde des illustrations de cartes RiftCardex.
//
// POURQUOI : l'app streame ses illustrations depuis le CDN Riot (cmsassets.rgpub.io).
// Si ce CDN disparait, toutes les cartes deviennent grises pour tout le monde d'un coup,
// et rien ne permet de re-heberger. La seule parade est d'avoir les PNG full-res ailleurs.
//
// FAIT MESURE (12/06 -> 24/07) : 22 illustrations ont change de contenu. 17 avaient un
// chemin Sanity different (detectable par comparaison d'URL) ; 5 avaient la MEME URL pour
// des octets differents (dont au moins un telechargement tronque de notre cote). Une
// archive faite une fois se perime donc sans que rien ne le dise.
//
// DEUX FICHIERS, DEUX ROLES DISTINCTS -- ne pas les confondre :
//   arts/observed.json  ce qu'on a VU au catalogue au dernier passage. Ecrit toujours.
//                       Son historique git est le JOURNAL date des changements chez Riot.
//   arts/manifest.json  ce qui est REELLEMENT sauvegarde (telecharge avec succes). Ecrit
//                       seulement en mode telechargement. C'est lui qui decide du travail.
// Les separer est ce qui permet d'activer la sauvegarde apres des mois de journal seul :
// le manifeste est alors vide, donc tout est a telecharger. Un fichier unique aurait fait
// croire au script que tout etait deja sauvegarde, et le bucket serait reste vide.
//
// Le depot est PUBLIC : on n'y commit QUE des URL deja publiques, jamais un octet d'art.
//
// Usage :
//   node sync-arts.mjs                # journal + telechargement des manquants dans _arts/
//   node sync-arts.mjs --no-download  # journal seul, aucun octet telecharge

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ARTS = join(ROOT, 'arts');
const MANIFEST_PATH = join(ARTS, 'manifest.json');
const OBSERVED_PATH = join(ARTS, 'observed.json');
const SUPPLEMENT_PATH = join(ARTS, 'supplement.json');
const OUT_DIR = join(ROOT, '_arts');
const REPLACED_PATH = join(OUT_DIR, '_remplacees.txt');
const FAILURES_PATH = join(OUT_DIR, '_echecs.txt');

const API = 'https://api.riftcodex.com';
const UA = 'RiftCardex/1.0 (+https://riftcardex.fr) arts-backup';

const NO_DOWNLOAD = process.argv.includes('--no-download');
const POOL = 6;
const PAUSE_MS = 250;
const MIN_BYTES = 10000;
const SEUIL_DISPARITION = 0.05;
// Bornes ABSOLUES qui doublent les pourcentages ci-dessus. Un seuil exprime en % se
// perime tout seul : la zone aveugle grandit avec le corpus. Mesure du 2026-09-14 --
// a 1328 arts, le seul seuil global laissait passer 66 disparitions en silence, soit
// OGS + PR + JDG reunis.
const SEUIL_GLOBAL_PLAFOND = 50;
const SEUIL_SET_PLANCHER = 3;
const SEUIL_SET_PART = 0.10;

// CODES DE SORTIE -- une panne amont n'est pas un bug chez nous. Les confondre fait
// lire un run rouge comme du code casse, et coute une enquete a chaque fois (vecu le
// 2026-09-14 : "Error: 524" + une stack Node, pour une API qui ne repondait pas).
// Meme doctrine que les sentinelles, cf. docs/reference/SENTINELLES.md §2.1 du depot
// applicatif. Les deux sont NON NULS : le rouge reste le canal e-mail.
const CODE_BUG_LOCAL = 1;
const CODE_PANNE_AMONT = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function canon(o) {
  return JSON.stringify(o, (key, value) =>
    (value && typeof value === 'object' && !Array.isArray(value))
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
      : value, 1);
}

// Riot ajoute et retire ?accountingTag=RB au fil du temps sans toucher au fichier :
// mesure du 24/07, 362 URL le portaient en juin contre 1311 aujourd'hui. Comparer les
// URL brutes ferait passer ~800 cartes pour "remplacees" et noierait le vrai journal.
// Le chemin Sanity contient le hash du contenu : c'est lui qui fait foi.
function norm(url) { return String(url ?? '').split('?')[0]; }

// Le 2026-09-14, cette fonction a consomme 8 min 34 s sans imprimer UNE SEULE LIGNE
// avant l'erreur finale : 5 tentatives x ~100 s de 524 Cloudflare. D'ou deux ajouts
// qui ne changent rien au comportement mais tout a la lisibilite -- l'URL dans le
// message (elle etait perdue par le throw du status seul, il fallait compter les
// lignes du fichier pour savoir QUEL appel avait echoue) et une trace par tentative.
//
// Pas de garde-temps par requete, DELIBEREMENT : une reponse legitime a ete mesuree
// a 38 s de TTFB en mode degrade. Tout seuil sous ~60 s transformerait un run qui
// aurait abouti en run rouge. La borne qui protege vraiment est `timeout-minutes`
// sur le job, dans arts.yml -- elle couvre aussi le pool de telechargement.
async function getJson(url, retries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429 || r.status >= 500) {
        const e = new Error(`${r.status} sur ${url}`);
        e.amont = true;
        throw e;
      }
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} sur ${url}`);
      return await r.json();
    } catch (e) {
      if (i >= retries) throw e;
      console.error(`  tentative ${i + 1}/${retries + 1} echouee (${e.message}) -- nouvel essai`);
      await sleep(600 * (i + 1));
    }
  }
}

// Convention identique a tools/download-images.ps1 et tools/backup-arts.ps1 du depot
// applicatif, pour que l'archive locale et le bucket soient superposables.
function keyFor(card) {
  return `${card.set.set_id.toLowerCase()}/${card.riftbound_id.replace(/\*/g, '_star')}.png`;
}

// Un corps d'erreur HTTP renomme .png passe tous les tests de taille naifs.
// On regarde les octets de tete. PNG | WEBP (RIFF) | JPEG.
function looksLikeImage(buf) {
  if (buf.length < MIN_BYTES) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8) return true;
  return false;
}

function readArts(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')).arts ?? {};
}

// COMPARER L'AVANT ET L'APRES -- fonction PURE, sans reseau ni disque, pour etre
// testable (voir sync-arts.test.mjs). C'est le seul endroit qui decide si le journal
// a le droit d'etre reecrit.
//
// POURQUOI DES GARDES ICI ET PAS SEULEMENT DANS harvest() : le garde de harvest
// (`got !== total`) compare l'API A SA PROPRE DECLARATION. Une origine degradee qui
// sert {items: [243 fiches], total: 243} est verte par construction, et un set qui
// revient vide (total: 0) ne leve rien du tout. Ces deux cas n'arrivent jusqu'ici
// que sous la forme de disparitions -- c'est donc ici qu'on peut les refuser.
//
// LE DEGAT QU'ON EMPECHE n'est pas la panne, c'est le MENSONGE DATE : si on ecrit un
// journal ampute, ces arts reviennent la semaine suivante et sont journalises "vues
// pour la premiere fois". Une entree datee fausse, impossible a distinguer d'un vrai
// ajout Riot, dans le seul artefact qui donne sa valeur au dispositif.
export function analyser(observed, wanted) {
  const cles = Object.keys(observed);
  const vus = cles.length;
  const disparues = cles.filter((k) => !(k in wanted));
  const refus = [];

  // Les clefs valent "<set>/<riftbound_id>.png" (cf. keyFor) : le prefixe suffit a
  // raisonner par set, sans rien reinterroger.
  const setDe = (k) => k.split('/')[0];
  const parSet = (liste) => liste.reduce((acc, k) => {
    const s = setDe(k);
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  const connuParSet = parSet(cles);
  const perduParSet = parSet(disparues);

  for (const [set, perdu] of Object.entries(perduParSet)) {
    const connu = connuParSet[set];
    // Un set entier qui s'evapore est TOUJOURS une reponse tronquee : Riot ne retire
    // pas une extension du jour au lendemain. C'est le cas que le seuil global ne
    // pouvait pas voir -- OGS (24), PR (13) et JDG (3) tiennent tous les trois sous
    // les 66 disparitions qu'il tolerait.
    if (perdu === connu) {
      refus.push(`le set ${set.toUpperCase()} disparait EN ENTIER (${perdu} illustrations connues, zero servie).`);
      continue;
    }
    const seuilSet = Math.max(SEUIL_SET_PLANCHER, connu * SEUIL_SET_PART);
    if (perdu > seuilSet) {
      refus.push(`${set.toUpperCase()} perd ${perdu} illustrations sur ${connu} connues (plafond ${Math.floor(seuilSet)}).`);
    }
  }

  // Filet de second rang, conserve. ⚠️ BORNE ABSOLUE en plus du pourcentage : un
  // seuil exprime en % se perime tout seul, puisque la zone aveugle grandit avec le
  // corpus. A 1328 arts il tolerait deja 66 disparitions silencieuses.
  const seuilGlobal = Math.min(Math.max(10, vus * SEUIL_DISPARITION), SEUIL_GLOBAL_PLAFOND);
  if (vus > 0 && disparues.length > seuilGlobal) {
    refus.push(`${disparues.length} illustrations disparaissent d'un coup sur ${vus} connues (plafond ${Math.floor(seuilGlobal)}).`);
  }

  return {
    nouvelles: Object.keys(wanted).filter((k) => !(k in observed)),
    changees: Object.keys(wanted).filter((k) => k in observed && norm(observed[k]) !== norm(wanted[k])),
    disparues,
    refus,
  };
}

// N'ecrit que si la carte des arts a bouge : sinon generated_at ferait un commit vide
// chaque semaine et l'historique git cesserait d'etre un journal lisible.
function writeIfChanged(path, arts, label) {
  const previous = readArts(path);
  if (canon(previous) === canon(arts)) { console.log(`${label} inchange (${Object.keys(arts).length} entrees)`); return; }
  mkdirSync(ARTS, { recursive: true });
  writeFileSync(path, canon({ generated_at: new Date().toISOString(), count: Object.keys(arts).length, arts }) + '\n', 'utf8');
  console.log(`${label} ecrit (${Object.keys(arts).length} entrees)`);
}

async function harvest() {
  // size est plafonne a 100 par l'API (au-dela : 422). 8 sets aujourd'hui, mais on
  // refuse de tourner si la pagination se declenche plutot que de perdre des sets.
  const sets = await getJson(`${API}/sets?size=100`);
  if (!Array.isArray(sets.items) || sets.items.length === 0) throw new Error('/sets ne renvoie aucun set');
  // `sets.pages > 1` est SILENCIEUSEMENT FAUX si le champ disparait (undefined > 1
  // vaut false) : la garde anti-changement-de-forme ne se declenchait pas sur un
  // changement de forme. Le chemin /cards exigeait deja Number.isInteger ; on aligne.
  if (!Number.isInteger(sets.pages) || !Number.isInteger(sets.total)) throw new Error("/sets ne renvoie pas 'pages'/'total' -- forme d'API changee");
  if (sets.pages > 1) throw new Error(`/sets est pagine (${sets.pages} pages) -- paginer la boucle`);
  if (sets.items.length !== sets.total) throw new Error(`/sets : ${sets.items.length} sets servis pour ${sets.total} annonces`);
  const cards = [];
  for (const s of sets.items) {
    let page = 1, pages = 1, total = null;
    // On compte les IDENTITES servies par CE set, et non les fiches accumulees pour
    // tous les sets. L'ancien `cards.filter(...)` etait juste par coincidence, et il
    // restait vert si une page etait servie DEUX FOIS : le compte tombait juste alors
    // que 100 fiches distinctes manquaient.
    const ids = new Set();
    do {
      const r = await getJson(`${API}/cards?set_id=${s.set_id}&size=100&sort=collector_number&dir=1&page=${page}`);
      if (!Number.isInteger(r.pages)) throw new Error(`/cards ne renvoie pas 'pages' pour ${s.set_id} -- forme d'API changee`);
      cards.push(...r.items);
      for (const c of r.items) ids.add(c.id);
      pages = r.pages;
      total = r.total;
      page += 1;
    } while (page <= pages);
    // `!= null` et non `!== null` : si l'API cesse de servir 'total', le champ vaut
    // undefined et l'ancienne comparaison levait "... pour undefined annoncees" au
    // lieu de se desactiver comme l'initialisation a null le laissait croire.
    if (total != null && ids.size !== total) throw new Error(`${s.set_id} : ${ids.size} fiches distinctes pour ${total} annoncees`);
  }
  return cards;
}

async function download(url) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      const annonce = r.headers.get('content-length');
      const buf = Buffer.from(await r.arrayBuffer());
      // LE PIEGE QUE looksLikeImage NE VOIT PAS, et qui est deja arrive (cf. l'en-tete
      // du fichier : "au moins un telechargement tronque de notre cote"). Un PNG coupe
      // a 300 Ko sur 760 garde sa signature 89 50 4E 47 et passe le plancher de 10 Ko.
      // Il entrerait alors au manifeste, et `aTelecharger` ne le retenterait JAMAIS
      // puisqu'il filtre sur l'absence de la clef : la corruption devient permanente
      // et silencieuse -- exactement ce que ce script existe pour empecher.
      if (annonce && buf.length !== Number(annonce)) throw new Error(`tronque : ${buf.length} o recus pour ${annonce} annonces`);
      if (!looksLikeImage(buf)) throw new Error(`reponse non-image (${buf.length} o)`);
      return buf;
    } catch (e) {
      if (i >= 3) throw e;
      await sleep(800 * (i + 1));
    }
  }
}

async function main() {
  const cards = await harvest();
  console.log(`API : ${cards.length} fiches`);

  const wanted = {};
  const collisions = [];
  let skipped = 0;
  for (const c of cards) {
    if (!c.media?.image_url || !c.riftbound_id || !c.set?.set_id) { skipped += 1; continue; }
    const k = keyFor(c);
    if (k in wanted) {
      if (norm(wanted[k]) !== norm(c.media.image_url)) collisions.push(`${k} <- ${c.name}`);
      continue;
    }
    wanted[k] = c.media.image_url;
  }
  console.log(`API : ${Object.keys(wanted).length} illustrations distinctes (${skipped} fiches inexploitables)`);

  // Le catalogue applicatif contient des cartes que l'API ne sert pas ou plus (runes du
  // supplement, cartes VEN retirees de l'API mais bien livrees dans l'app). Sans cette
  // liste elles ne seraient sauvegardees nulle part.
  if (existsSync(SUPPLEMENT_PATH)) {
    const extra = JSON.parse(readFileSync(SUPPLEMENT_PATH, 'utf8')).arts ?? {};
    let n = 0;
    for (const [k, url] of Object.entries(extra)) { if (!(k in wanted)) { wanted[k] = url; n += 1; } }
    console.log(`supplement : +${n} illustrations hors API -> ${Object.keys(wanted).length} au total`);
  }

  if (collisions.length) {
    console.log(`ATTENTION : ${collisions.length} collision(s) riftbound_id avec des arts DIFFERENTS -- une seule sera sauvegardee :`);
    for (const x of collisions) console.log(`   ${x}`);
  }

  // --- Journal : ce que Riot a change depuis le dernier passage ---
  const observed = readArts(OBSERVED_PATH);
  const bilan = analyser(observed, wanted);
  for (const r of bilan.refus) console.error(`REFUS : ${r}`);
  if (bilan.refus.length) {
    console.error("C'est un symptome de reponse d'API tronquee, pas d'un vrai retrait. Rien n'est ecrit.");
    process.exitCode = CODE_PANNE_AMONT;
    return;
  }
  const { nouvelles: nouvellesVues, changees: changeesVues, disparues } = bilan;
  console.log(`JOURNAL -- vues pour la premiere fois : ${nouvellesVues.length} | changees chez Riot : ${changeesVues.length} | disparues du catalogue : ${disparues.length}`);
  for (const k of changeesVues) console.log(`   changee : ${k}\n      avant : ${observed[k]}\n      apres : ${wanted[k]}`);
  for (const k of disparues) console.log(`   disparue du catalogue (jamais supprimee du stockage) : ${k}`);

  // --- Travail : ce qui n'est pas encore sauvegarde ---
  const saved = readArts(MANIFEST_PATH);
  const aTelecharger = Object.keys(wanted).filter((k) => !(k in saved));
  const aRemplacer = Object.keys(wanted).filter((k) => k in saved && norm(saved[k]) !== norm(wanted[k]));
  console.log(`SAUVEGARDE -- deja sauvegardees : ${Object.keys(saved).length} | a telecharger : ${aTelecharger.length} | a remplacer : ${aRemplacer.length}`);

  writeIfChanged(OBSERVED_PATH, wanted, 'arts/observed.json');

  if (NO_DOWNLOAD) {
    console.log('--no-download : journal seul. arts/manifest.json (ce qui est sauvegarde) reste inchange.');
    return;
  }

  const todo = [...aTelecharger, ...aRemplacer];
  if (todo.length === 0) { console.log('Rien a telecharger : tout le catalogue est deja sauvegarde.'); return; }

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const nouveau = { ...saved };
  const failures = [];
  let ok = 0, cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const k = todo[cursor++];
      try {
        const buf = await download(wanted[k]);
        const dest = join(OUT_DIR, k);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, buf);
        nouveau[k] = wanted[k];
        ok += 1;
        if (ok % 100 === 0) console.log(`   ...${ok}/${todo.length}`);
      } catch (e) {
        failures.push(`${k} : ${e.message}`);
      }
      await sleep(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));
  console.log(`telechargees : ${ok}/${todo.length}`);

  // Le workflow recopie l'ancienne version sous un prefixe date AVANT de l'ecraser.
  // Saut de ligne final obligatoire : un 'while read' de shell ignore la derniere ligne
  // d'un fichier qui n'en a pas, et l'ancienne version serait perdue.
  const remplacees = aRemplacer.filter((k) => k in nouveau && nouveau[k] === wanted[k]);
  writeFileSync(REPLACED_PATH, remplacees.length ? remplacees.join('\n') + '\n' : '', 'utf8');

  if (failures.length) {
    console.log(`ECHECS (${failures.length}) -- ces illustrations ne sont PAS sauvegardees :`);
    for (const f of failures) console.log(`   ${f}`);
    // Une illustration non recuperee ne doit pas entrer au manifeste, sinon le passage
    // suivant la croira sauvegardee et ne la retentera jamais. Le workflow lit ce fichier
    // pour faire echouer le run : le rouge est le seul signal d'un cron non surveille.
    writeFileSync(FAILURES_PATH, failures.join('\n') + '\n', 'utf8');
  }

  writeIfChanged(MANIFEST_PATH, nouveau, 'arts/manifest.json');
}

// Le run reste ROUGE dans les deux cas -- l'echec du job EST le canal e-mail, et le
// verdir "parce que ce n'est pas de notre faute" supprimerait le seul temoin que ce
// cron est vivant : writeIfChanged n'ecrit que sur changement, donc un journal fige
// est indistinguable d'un journal a l'arret. Ce qui change, c'est ce qu'on LIT.
// N'AGIT QUE SI ON EST LE PROGRAMME LANCE. Sans cette garde, importer ce fichier pour
// tester analyser() partirait interroger l'API et ecrire dans arts/.
const lanceDirectement = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (lanceDirectement) main().catch((e) => {
  if (e?.amont) {
    console.error(`PANNE AMONT : ${e.message}`);
    console.error("L'API n'a pas repondu. RIEN n'a ete ecrit, et il n'y a aucun geste a faire de notre cote.");
    console.error('Si ca dure : la source est-elle degradee, ou notre acces refuse ? (403 = refus, 5xx = origine.)');
    process.exitCode = CODE_PANNE_AMONT;
    return;
  }
  console.error(e);
  process.exitCode = CODE_BUG_LOCAL;
});
