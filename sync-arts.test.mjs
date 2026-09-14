// Tests de la seule logique de decision de sync-arts.mjs : analyser().
//
// POURQUOI CES TESTS EXISTENT. Le 2026-09-14, une relecture croisee a trouve que ce
// script pouvait ecrire un journal AMPUTE sans qu'aucune garde ne bronche, si l'API
// repondait 200 mais incomplet. Le degat n'est pas la panne : c'est qu'au passage
// suivant les arts manquants reviennent et sont journalises "vues pour la premiere
// fois" -- une entree datee fausse, impossible a distinguer d'un vrai ajout Riot,
// dans le seul artefact qui donne sa valeur au dispositif.
//
// Ces trous sont exactement de la forme qu'un test attrape et qu'une relecture manque.
//
//   node --test sync-arts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyser } from './sync-arts.mjs';

const URL_A = 'https://cmsassets.rgpub.io/sanity/images/x/aaa-744x1039.png';
const URL_B = 'https://cmsassets.rgpub.io/sanity/images/x/bbb-744x1039.png';

// Un catalogue credible : de gros sets, et les trois petits qui tenaient sous
// l'ancien seuil global (OGS 24 + PR 13 + JDG 3 = 40 contre 66 tolerees).
function catalogue({ ogn = 352, sfd = 294, ogs = 24, pr = 13, jdg = 3 } = {}) {
  const arts = {};
  const remplir = (set, n) => { for (let i = 1; i <= n; i++) arts[`${set}/${set}-${String(i).padStart(3, '0')}.png`] = URL_A; };
  remplir('ogn', ogn); remplir('sfd', sfd); remplir('ogs', ogs); remplir('pr', pr); remplir('jdg', jdg);
  return arts;
}

const sansSet = (arts, set) => Object.fromEntries(Object.entries(arts).filter(([k]) => !k.startsWith(`${set}/`)));
const sansN = (arts, set, n) => {
  const cles = Object.keys(arts).filter((k) => k.startsWith(`${set}/`)).slice(0, n);
  return Object.fromEntries(Object.entries(arts).filter(([k]) => !cles.includes(k)));
};

test('rien n a bouge : aucun refus, aucun mouvement', () => {
  const observed = catalogue();
  const r = analyser(observed, { ...observed });
  assert.deepEqual(r.refus, []);
  assert.equal(r.nouvelles.length, 0);
  assert.equal(r.changees.length, 0);
  assert.equal(r.disparues.length, 0);
});

test('un art remplace chez Riot est vu comme change, pas comme disparu', () => {
  const observed = catalogue();
  const wanted = { ...observed, 'ogn/ogn-001.png': URL_B };
  const r = analyser(observed, wanted);
  assert.deepEqual(r.refus, []);
  assert.deepEqual(r.changees, ['ogn/ogn-001.png']);
  assert.equal(r.disparues.length, 0);
});

test("le parametre ?accountingTag ne compte pas comme un changement", () => {
  const observed = catalogue();
  const wanted = { ...observed, 'ogn/ogn-001.png': `${URL_A}?accountingTag=RB` };
  assert.equal(analyser(observed, wanted).changees.length, 0);
});

// LE CAS QUI A MOTIVE TOUT LE LOT. Un set entier qui s'evapore passait en silence :
// 24 disparitions contre un seuil global de 66.
test('un set entier qui disparait est REFUSE, meme tres en dessous du seuil global', () => {
  const observed = catalogue();
  const r = analyser(observed, sansSet(observed, 'ogs'));
  assert.equal(r.disparues.length, 24);
  assert.equal(r.refus.length, 1);
  assert.match(r.refus[0], /OGS disparait EN ENTIER/);
});

test('les trois petits sets ensemble (40) etaient sous l ancien seuil de 66 : refuses maintenant', () => {
  const observed = catalogue();
  let wanted = sansSet(observed, 'ogs');
  wanted = sansSet(wanted, 'pr');
  wanted = sansSet(wanted, 'jdg');
  const r = analyser(observed, wanted);
  assert.equal(r.disparues.length, 40);
  // 3 refus par set + 1 refus global : a 686 arts connus le filet global tombe a
  // 34 disparitions tolerees, et 40 le depassent. Les deux gardes sont volontairement
  // redondantes -- celle par set voit ce que la globale ne peut pas voir, pas l inverse.
  assert.equal(r.refus.length, 4);
  assert.equal(r.refus.filter((x) => /EN ENTIER/.test(x)).length, 3);
});

test('une page perdue sur un gros set (100 fiches) est refusee par le garde de set', () => {
  const observed = catalogue();
  const r = analyser(observed, sansN(observed, 'ogn', 100));
  assert.ok(r.refus.some((x) => /OGN perd 100 illustrations sur 352/.test(x)));
});

// Le pendant : une vraie petite variation ne doit PAS bloquer le journal, sinon le
// dispositif crie a chaque errata Riot et on apprend a l'ignorer.
test('un retrait reel et minuscule passe sans refus', () => {
  const observed = catalogue();
  const r = analyser(observed, sansN(observed, 'ogn', 2));
  assert.deepEqual(r.refus, []);
  assert.equal(r.disparues.length, 2);
});

test('le plancher par set protege les petits sets d une perte proportionnellement grosse', () => {
  const observed = catalogue();
  // 4 sur 13 = 31 %, bien au-dela des 10 % tolERes, et au-dessus du plancher de 3.
  const r = analyser(observed, sansN(observed, 'pr', 4));
  assert.ok(r.refus.some((x) => /PR perd 4 illustrations sur 13/.test(x)));
});

test('le seuil global garde une BORNE ABSOLUE : il ne se perime pas quand le corpus grandit', () => {
  // 4000 arts repartis sur un seul set : 5 % vaudraient 200 disparitions tolerees.
  const observed = {};
  for (let i = 1; i <= 4000; i++) observed[`ogn/ogn-${i}.png`] = URL_A;
  const wanted = Object.fromEntries(Object.entries(observed).slice(0, 4000 - 120));
  const r = analyser(observed, wanted);
  assert.ok(r.refus.some((x) => /120 illustrations disparaissent.*plafond 50/.test(x)),
    `le plafond absolu doit s appliquer, refus obtenus : ${JSON.stringify(r.refus)}`);
});

test('premier passage (journal vide) : tout est nouveau, rien n est refuse', () => {
  const wanted = catalogue();
  const r = analyser({}, wanted);
  assert.deepEqual(r.refus, []);
  assert.equal(r.nouvelles.length, Object.keys(wanted).length);
  assert.equal(r.disparues.length, 0);
});

test('un set NOUVEAU chez Riot arrive sans declencher de refus', () => {
  const observed = catalogue();
  const wanted = { ...observed };
  for (let i = 1; i <= 300; i++) wanted[`rad/rad-${String(i).padStart(3, '0')}.png`] = URL_A;
  const r = analyser(observed, wanted);
  assert.deepEqual(r.refus, []);
  assert.equal(r.nouvelles.length, 300);
});
