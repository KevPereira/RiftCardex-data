// Collecteur de prix quotidien RiftCardex.
// Ne fait QUE des lookups sur une jointure GELEE (prices/price-map.json produite sur le poste de KP
// par tools/construire-table-prix.ps1). Ne rejoue JAMAIS la jointure positionnelle fragile (B1).
// Cardmarket (EUR) et TCGplayer (USD) restent DEUX marches separes, jamais fusionnes/convertis (D1/D2).
// Garde-fou de resolution >= 95% : en dessous, on ne publie pas (B2). Kill-switch enabled:false (B4).
// Contenu indexe par NOTRE id de carte, jamais par idProduct (etancheite).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PRICES = join(ROOT, 'prices');
const MAP_PATH = join(PRICES, 'price-map.json');
const OUT_PATH = join(PRICES, 'prices.json');
const MANIFEST_PATH = join(PRICES, 'manifest.json');
const SEUIL_RESOLUTION = 0.95;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
               const h = tnum(n.highPrice); if (h !== null) o.high = h; }
      if (f) { const m = tnum(f.marketPrice); if (m !== null) o.usdFoil = m; }
      if (Object.keys(o).length) entry.tcg = o;
    }

    if (entry.cm || entry.tcg) { out[c.id] = entry; if (cotable) resolus++; }
  }

  const rate = cotables ? resolus / cotables : 0;
  console.log(`Resolution : ${resolus}/${cotables} = ${(rate * 100).toFixed(1)}%  (${Object.keys(out).length} cartes cotees)`);

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
  let enabledSame = false;
  if (existsSync(MANIFEST_PATH)) {
    try { enabledSame = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).enabled === enabled; } catch (_) {}
  }
  if (pricesSame && enabledSame) {
    console.log('Prix et kill-switch inchanges -> aucun commit.');
    return;
  }

  writeFileSync(OUT_PATH, nouveau + '\n');
  const manifest = {
    generated_at: new Date().toISOString(),
    cm_updated_at: cm.lastModified || null,
    count: Object.keys(out).length,
    resolution: Number((rate * 100).toFixed(1)),
    enabled,
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`ECRIT : prices.json (${manifest.count} cartes) + manifest.json (enabled=${manifest.enabled})`);
}

main().catch((e) => { console.error('ECHEC collecteur :', e.message); process.exit(1); });
