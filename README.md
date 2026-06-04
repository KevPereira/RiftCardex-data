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
