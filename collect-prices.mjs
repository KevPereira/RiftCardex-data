// Collecteur de prix quotidien RiftCardex.
// Ne fait QUE des lookups sur une jointure GELEE (prices/price-map.json produite sur le poste de KP
// par tools/construire-table-prix.ps1). Ne rejoue JAMAIS la jointure positionnelle fragile (B1).
// Cardmarket (EUR) et TCGplayer (USD) restent DEUX marches separes, jamais fusionnes/convertis (D1/D2).
// Garde-fou de resolution >= 95% : en dessous, on ne publie pas (B2). Kill-switch enabled:false (B4).
// Contenu indexe par NOTRE id de carte, jamais par idProduct (etancheite).

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PRICES = join(ROOT, 'prices');
const MAP_PATH = join(PRICES, 'price-map.json');
const OUT_PATH = join(PRICES, 'prices.json');
const MANIFEST_PATH = join(PRICES, 'manifest.json');
const SEUIL_RESOLUTION = 0.95;

// Le catalogue VIVANT est celui que sert l app web : elle le re-embarque a chaque
// deploiement. Le dossier catalogue/ de CE depot est gele depuis le 2026-06-04 et ne
// dit plus rien de ce que les utilisateurs voient -- ne jamais le prendre pour reference.
const CATALOGUE_URL = 'https://app.riftcardex.com/assets/assets/catalogue/cards.json';

const UA = 'RiftCardex/1.0 (+https://riftcardex.fr) price-collector';

function canon(o) {
  return JSON.stringify(o, (key, value) =>
    (value && typeof value === 'object' && !Array.isArray(value))
      ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
      : value, 1);
}

const SENTINEL = 999.99; // TCGCSV ecrit exactement 999.99 en placeholder "pas de donnee" -> a rejeter (mais 1159, 2000... sont de vrais prix chase)

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tnum(v) { const x = num(v); return x !== null && x !== SENTINEL ? x : null; }

// TCGCSV colle aussi une annonce "parking" (un vendeur qui gele son stock a un prix
// delirant) sur highPrice : 999.99, l'entier 999, ou un pic detache du reste. On ne jette
// high QUE si high >= 999 ET high >= 20x le vrai marche (ancre = max marche/milieu/bas) :
// une vraie carte chere a un high proche de son marche (ratio ~1x) et n'est jamais touchee
// (mesure 19/07 : plus haut "high" legitime = 89,98$, tous les parking = 999 a 50x-2854x).
// Ancre a 0 (aucun autre prix) -> un high >= 999 solitaire est du parking, on jette.
function highNum(v, anchor) {
  const h = tnum(v);
  if (h === null) return null;
  if (h >= 999 && h >= 20 * anchor) return null;
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Compte ce que la table gelee NE VOIT PAS. Sans ca, "resolution 98%" reste vert le jour
// ou un set entier sort : une carte absente de la table n est pas "non resolue", elle n est
// pas comptee du tout (le denominateur, c est map.cards, pas le catalogue).
//
// Best-effort STRICT : ce canal publie des prix, il ne doit jamais tomber parce qu une
// mesure de supervision a echoue. Toute panne ici -> avertissement, jamais exit 1.
async function mesurerEcart(map) {
  try {
    const r = await fetch(CATALOGUE_URL, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const cat = JSON.parse((await r.text()).replace(/^\uFEFF/, ''));
    const cartes = Array.isArray(cat) ? cat : (cat.items || cat.cards);
    // Plancher : un catalogue tronque ferait croire a un ecart enorme et crierait a tort.
    if (!Array.isArray(cartes) || cartes.length < 900) {
      throw new Error(`catalogue implausible (${cartes && cartes.length})`);
    }
    const vivant = new Set(cartes.map((c) => c.id));
    const gelee = new Set(map.cards.map((c) => c.id));
    const hors = new Set([...vivant].filter((id) => !gelee.has(id)));
    const orphelins = [...gelee].filter((id) => !vivant.has(id)).length;
    // Le detail par serie est ce qui dit "un set entier est arrive" plutot que "3 promos".
    const parSerie = {};
    for (const c of cartes) {
      if (!hors.has(c.id)) continue;
      const s = (c.set && c.set.set_id) || '?';
      parSerie[s] = (parSerie[s] || 0) + 1;
    }
    return { catalogue: cartes.length, horsTable: hors.size, orphelins, parSerie };
  } catch (e) {
    console.warn(`AVERTISSEMENT : catalogue vivant illisible (${e.message}) -> ecart non mesure.`);
    return null;
  }
}

async function getJson(url, retries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.status === 429 || r.status >= 500) throw new Error(String(r.status));
      if (!r.ok) throw new Error(`${r.status} ${r.statusText} sur ${url}`);
      return { json: await r.json(), lastModified: r.headers.get('last-modified') };
    } catch (e) {
      if (i >= retries) throw e;
      await sleep(600 * (i + 1)); // backoff : TCGCSV jette les rafales
    }
  }
}

async function main() {
  const map = JSON.parse(readFileSync(MAP_PATH, 'utf8'));
  console.log(`price-map : ${map.count} cartes, ${map.cotables} cotables (gele le ${map.generated_at})`);

  // --- Cardmarket : le price guide entier, indexe par idProduct ---
  const cm = await getJson(map.cm_price_url);
  const cmByProduct = new Map();
  for (const p of cm.json.priceGuides) cmByProduct.set(String(p.idProduct), p);
  console.log(`Cardmarket : ${cmByProduct.size} prix (maj ${cm.lastModified || '?'})`);

  // --- TCGplayer (TCGCSV) : prix de chaque groupe, indexes par productId|finition ---
  const tcgByKey = new Map();
  for (const gid of map.tcg_groups) {
    // Pas de try/catch silencieux : un groupe qui echoue apres retries fait
    // echouer TOUT le collecteur (mieux qu'une donnee TCGP partielle a 0 e).
    const { json } = await getJson(`${map.tcg_base}/${gid}/prices`);
    for (const p of json.results) tcgByKey.set(`${p.productId}|${p.subTypeName}`, p);
    await sleep(250);
  }
  console.log(`TCGplayer : ${tcgByKey.size} lignes de prix`);

  // --- Lookups : un prix par NOTRE id, CM et TCGP separes ---
  const CM_COLS = [['avg', 'avg'], ['low', 'low'], ['trend', 'trend'], ['avg1', 'avg1'], ['avg7', 'avg7'], ['avg30', 'avg30'],
                   ['avg-foil', 'avgFoil'], ['low-foil', 'lowFoil'], ['trend-foil', 'trendFoil']];
  const out = {};
  let cotables = 0, resolus = 0;

  for (const c of map.cards) {
    const cotable = Boolean(c.cm || c.tcg);
    if (cotable) cotables++;
    const entry = {};

    if (c.cm) {
      const pg = cmByProduct.get(String(c.cm));
      if (pg) {
        const o = {};
        for (const [src, dst] of CM_COLS) { const v = num(pg[src]); if (v !== null) o[dst] = v; }
        // Garde anti-trend-fantome : le prix de reference est une colonne A VOLUME (avg), jamais trend/low seul.
        const eur = o.avg ?? o.avg30 ?? o.avg7 ?? o.avg1 ?? null;
        if (eur !== null) o.eur = eur;
        if (o.avgFoil !== undefined) o.eurFoil = o.avgFoil;
        if (Object.keys(o).length) entry.cm = o;
      }
    }

    if (c.tcg) {
      const n = tcgByKey.get(`${c.tcg}|Normal`);
      const f = tcgByKey.get(`${c.tcg}|Foil`);
      const o = {};
      if (n) { const m = tnum(n.marketPrice); if (m !== null) o.usd = m;
               const l = tnum(n.lowPrice); if (l !== null) o.low = l;
               const mi = tnum(n.midPrice); if (mi !== null) o.mid = mi;
               const anchor = Math.max(m ?? 0, l ?? 0, mi ?? 0);
               const h = highNum(n.highPrice, anchor); if (h !== null) o.high = h; }
      if (f) { const m = tnum(f.marketPrice); if (m !== null) o.usdFoil = m; }
      if (Object.keys(o).length) entry.tcg = o;
    }

    if (entry.cm || entry.tcg) { out[c.id] = entry; if (cotable) resolus++; }
  }

  const rate = cotables ? resolus / cotables : 0;
  console.log(`Resolution : ${resolus}/${cotables} = ${(rate * 100).toFixed(1)}%  (${Object.keys(out).length} cartes cotees)`);

  const ecart = await mesurerEcart(map);
  if (ecart) {
    console.log(
      `Catalogue vivant : ${ecart.catalogue} cartes | HORS TABLE ${ecart.horsTable}` +
      ` | orphelins ${ecart.orphelins}` +
      (ecart.horsTable ? ` | par serie ${JSON.stringify(ecart.parSerie)}` : ''),
    );
  }

  if (rate < SEUIL_RESOLUTION) {
    console.error(`ECHEC : resolution ${(rate * 100).toFixed(1)}% < ${SEUIL_RESOLUTION * 100}% -> flux suspect, on NE PUBLIE PAS.`);
    process.exit(1);
  }

  // Ne pas fabriquer de faux point d'historique : si les prix n'ont pas bouge, on ne
  // reecrit rien -- SAUF si le kill-switch (enabled) a change : il faut le propager.
  const enabled = process.env.PRICES_ENABLED === 'true';
  const nouveau = canon(out);
  const pricesSame =
    existsSync(OUT_PATH) && canon(JSON.parse(readFileSync(OUT_PATH, 'utf8'))) === nouveau;
  let precedent = null;
  if (existsSync(MANIFEST_PATH)) {
    try { precedent = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')); } catch (_) {}
  }
  const enabledSame = precedent !== null && precedent.enabled === enabled;

  // Catalogue illisible -> on REPORTE la valeur precedente. Ecrire null ferait croire
  // que l ecart s est resorbe, et provoquerait un commit pour rien.
  const horsAvant = (precedent && precedent.hors_table !== undefined) ? precedent.hors_table : null;
  const horsTable = ecart ? ecart.horsTable : horsAvant;
  const ecartSame = horsTable === horsAvant;

  // On alerte sur la CROISSANCE, pas sur une valeur absolue : le manifeste precedent sert
  // de reference et se remet a jour tout seul. Premier passage = on pose la reference en
  // silence. Un set qui sort fait bondir le compteur, et ca, il faut le savoir le jour meme.
  if (ecart && horsAvant !== null && ecart.horsTable > horsAvant) {
    const corps = [
      `Cartes du catalogue absentes de la table de prix : **${horsAvant} -> ${ecart.horsTable}**.`,
      `Detail par serie : \`${JSON.stringify(ecart.parSerie)}\``,
      `Catalogue vivant : ${ecart.catalogue} cartes | table gelee : ${map.cards.length} (${map.generated_at}).`,
      '',
      "Ces cartes n ont AUCUN prix et ne sont pas comptees dans le taux de resolution :",
      "il restera vert. Pour les coter, rejouer `tools/construire-table-prix.ps1` cote poste",
      "et pousser une nouvelle `prices/price-map.json`.",
    ].join('\n');
    console.warn(`ALERTE ECART : ${horsAvant} -> ${ecart.horsTable} cartes hors table.`);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `ecart_alerte=1\necart_corps<<FIN_ECART\n${corps}\nFIN_ECART\n`);
    }
  }

  // L horodatage pilote le RE-TELECHARGEMENT cote app (~376 Ko). Un ecart qui bouge est une
  // info de supervision, pas une donnee client : on reecrit le manifeste pour garder la
  // reference du prochain run, mais sans faire retelecharger le monde entier pour rien.
  const doitPropager = !pricesSame || !enabledSame;

  if (pricesSame && enabledSame && ecartSame) {
    console.log('Prix, kill-switch et ecart inchanges -> aucun commit.');
    return;
  }

  writeFileSync(OUT_PATH, nouveau + '\n');
  const manifest = {
    generated_at: (doitPropager || !precedent)
      ? new Date().toISOString()
      : precedent.generated_at,
    cm_updated_at: cm.lastModified || null,
    count: Object.keys(out).length,
    resolution: Number((rate * 100).toFixed(1)),
    // Ce que la table gelee ignore. `resolution` ne peut pas le voir par construction.
    catalogue_count: ecart ? ecart.catalogue : (precedent ? precedent.catalogue_count : null),
    hors_table: horsTable,
    enabled,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`ECRIT : prices.json (${manifest.count} cartes) + manifest.json (enabled=${manifest.enabled})`);
}

main().catch((e) => { console.error('ECHEC collecteur :', e.message); process.exit(1); });
