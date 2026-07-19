// Construit prices/history.json en rejouant le git log de prices/prices.json.
// Serie datee par carte de la colonne A VOLUME (cm.eur, tcg.usd) = le prix de
// reference (jamais un type brut). Dedup des points consecutifs egaux (courbe en
// escalier). Reapplique le filtre parking 999 a l'ingestion (histoire deja purgee
// mais garde-fou permanent). Tolerant aux schemas anciens.
//
// Rejoue TOUT le git log a chaque appel (peu de commits) -> idempotent, pas d'etat.
// A lancer dans le cron APRES le commit de la collecte du jour.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const git = (args, opts = {}) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, ...opts }).toString();

const OUT = 'prices/history.json';
const SENT = 999.99;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

// prix de reference par marche pour une entree carte, filtre parking
function ref(entry, market) {
  const o = market === 'cm' ? entry.cm : entry.tcg;
  if (!o) return null;
  const std = market === 'cm' ? 'eur' : 'usd';
  const v = num(o[std]) ?? num(o[market === 'cm' ? 'eurFoil' : 'usdFoil']);
  if (v === null || v === SENT) return null;
  // parking high (securite si un jour eur/usd portait un 999) : jamais ici en pratique
  return v >= 999 ? null : v;
}

// commits touchant prices.json, du plus ANCIEN au plus recent, avec date jour
const log = git(['log', '--reverse', '--format=%H %ad', '--date=short', '--', 'prices/prices.json'])
  .trim().split('\n').filter(Boolean)
  .map((l) => { const [h, d] = l.split(' '); return { h, d }; });

// history[id] = { cm: [[date, prix], ...], tcg: [...] }
const history = {};
const last = {}; // dernier prix vu par id|market (pour dedup)

for (const { h, d } of log) {
  let raw;
  try { raw = git(['show', `${h}:prices/prices.json`]); }
  catch { continue; }
  let data;
  try { data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw); }
  catch { continue; }
  for (const [id, entry] of Object.entries(data)) {
    for (const market of ['cm', 'tcg']) {
      const v = ref(entry, market);
      if (v === null) continue;
      const k = `${id}|${market}`;
      if (last[k] === v) continue; // dedup consecutif (escalier)
      last[k] = v;
      (history[id] ??= {});
      (history[id][market] ??= []).push([d, v]);
    }
  }
}

writeFileSync(OUT, JSON.stringify(history) + '\n');
const ids = Object.keys(history).length;
const pts = Object.values(history).reduce((s, e) => s + (e.cm?.length || 0) + (e.tcg?.length || 0), 0);
console.log(`ECRIT ${OUT} : ${ids} cartes, ${pts} points (${log.length} commits rejoues).`);
