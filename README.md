# RiftCardex — données du catalogue

Catalogue distant de l'application **RiftCardex** (suivi de collection du TCG
Riftbound). Permet de mettre à jour les cartes **sans republier l'app**.

Le dossier [`catalogue/`](catalogue/) contient :

| Fichier | Rôle |
|---|---|
| `manifest.json` | `{ version, generated_at, set_count, card_count }` — l'app compare `version` pour décider d'une mise à jour |
| `sets.json` | catalogue des séries |
| `cards.json` | catalogue des cartes |

## Mettre à jour

1. Dans le dépôt applicatif, lancer `tools/harvest-catalogue.ps1` (régénère les
   3 fichiers ; `manifest.json` **auto-incrémente** sa `version`).
2. Copier les 3 fichiers ici dans `catalogue/` et pousser.
3. Les utilisateurs reçoivent la mise à jour au prochain lancement (ou via
   **Réglages ▸ Catalogue ▸ Vérifier les mises à jour**).

> Dépôt **public** : `raw.githubusercontent.com` ne sert pas les dépôts privés
> sans jeton. Données de cartes dérivées de l'API Riftcodex ; ce projet est
> indépendant, non affilié à Riot Games.

## Sauvegarde des illustrations (`arts/`)

L'app ne stocke quasiment aucune illustration : elle les streame depuis le CDN Riot
(`cmsassets.rgpub.io`). Seules 12 variantes de runes non officielles sont servies
depuis ce dépôt via jsDelivr (`images/runes/`). Si le CDN de Riot disparaissait,
toutes les autres cartes deviendraient grises pour tout le monde, et rien ne
permettrait de ré-héberger. `sync-arts.mjs`, lancé chaque semaine par
[`arts.yml`](.github/workflows/arts.yml), tient le compte de ce qui existe et
sauvegarde ce qui manque.

| Fichier | Rôle |
|---|---|
| `arts/observed.json` | ce qu'on a **vu** au catalogue au dernier passage. Écrit à chaque run. **Son historique git est le journal daté des changements chez Riot.** |
| `arts/manifest.json` | ce qui est **réellement sauvegardé** (téléchargé avec succès). Écrit uniquement en mode téléchargement. C'est lui qui décide du travail à faire. |
| `arts/supplement.json` | les illustrations servies par le CDN Riot mais **absentes du harvest de l'API**, qui seraient sinon ratées |

> ⚠️ **Séparer `observed` de `manifest` n'est pas cosmétique.** C'est ce qui permet
> d'activer la sauvegarde après des mois de journal seul : le manifeste est alors
> vide, donc tout est à télécharger. Avec un fichier unique, le script aurait cru
> que tout était déjà sauvegardé et le bucket serait resté vide pour toujours.

> ⚠️ **Aucune illustration n'est commitée ici** (dépôt public, et ce serait
> redistribuer l'art de Riot). Seules des URL déjà publiques le sont. Le tampon
> de téléchargement `_arts/` est gitignoré.

**Pourquoi une vérification récurrente et pas un archivage une fois pour toutes :**
entre le 2026-06-12 et le 2026-07-24, **22 illustrations ont changé de contenu**.
**17** avaient un chemin Sanity différent (détectables en comparant les URL) ; **5**
avaient la **même URL pour des octets différents** — dont au moins un téléchargement
tronqué de notre côté. Une archive faite une seule fois se périme sans rien signaler.

> La comparaison ignore la query-string : Riot ajoute et retire `?accountingTag=RB`
> au fil du temps sans toucher au fichier (362 URL le portaient en juin, 1311
> aujourd'hui). Comparer les URL brutes ferait passer ~800 cartes pour « remplacées »
> et noierait le vrai journal. Le chemin Sanity contient le hash du contenu : c'est
> lui qui fait foi.

### Deux niveaux, pilotés par la variable de dépôt `ARTS_BACKUP_ENABLED`

- **Absente ou `false` (défaut)** — *journal seul*. Le job compare les URL et commite
  `observed.json`. Aucun octet téléchargé, **aucun secret nécessaire** : on sait déjà
  quand Riot remplace un art.
- **`true`** — téléchargement de tout ce qui n'est pas encore sauvegardé, puis envoi
  vers **Cloudflare R2**. Le premier passage envoie l'archive complète (~1 Go, 1328
  illustrations). Une illustration remplacée est d'abord recopiée sous
  `remplacees/<AAAAMMJJ>/` : Riot ne resservira jamais l'ancienne version. Si cette
  recopie échoue pour autre chose qu'un « objet inexistant », le job s'arrête **avant**
  d'écraser.

Secrets et variables attendus pour le niveau 2 :

| Nom | Type | Contenu |
|---|---|---|
| `ARTS_BACKUP_ENABLED` | variable | `true` pour activer le téléchargement + l'envoi |
| `R2_BUCKET` | variable | nom du bucket |
| `R2_ENDPOINT` | secret | `https://<account_id>.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | secret | jeton R2 |
| `R2_SECRET_ACCESS_KEY` | secret | jeton R2 |

Si un secret manque, l'envoi est **sauté sans faire échouer le run** — le manifeste
reste à jour.

> Le bucket doit rester **privé**. C'est de la conservation, pas de la diffusion :
> on ne l'ouvrirait au public que le jour où le CDN de Riot tomberait.

### À la main

```
node sync-arts.mjs --no-download   # journal seul
node sync-arts.mjs                 # télécharge ce qui manque dans _arts/
```

Une illustration qui n'a pas pu être récupérée **n'entre pas au manifeste** (sinon
le passage suivant la croirait sauvegardée et ne la retenterait jamais) et fait
**échouer le run** pour que le rouge soit visible dans l'interface GitHub.

Le job **refuse d'écrire** si plus de 5 % des illustrations connues disparaissent
d'un coup : c'est le symptôme d'une réponse d'API tronquée, pas d'un vrai retrait.

### Après chaque nouveau set

Rejouer la comparaison entre le catalogue applicatif et `arts/observed.json` : toute
carte livrée dans l'app mais absente du harvest de l'API doit être ajoutée à
`arts/supplement.json`, sinon son illustration n'est sauvegardée nulle part. Au
2026-07-24, 24 cartes sont dans ce cas (runes R01 de SFD/UNL, et 12 fiches VEN que
l'API ne renvoie plus).

Copie miroir côté poste de KP : `tools/backup-arts.ps1` du dépôt applicatif, même
convention de nommage (`<set>/<riftbound_id>.png`, `*` → `_star`) — les archives
courantes sont donc superposables. **Les versions remplacées, elles, ne le sont
pas** : en local `<nom>.png.replaced-AAAAMMJJ.png` à côté du fichier, sur R2 sous
le préfixe `remplacees/<AAAAMMJJ>/`.
