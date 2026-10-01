# Étude des commandes – Réseau Interkab

Tableau de bord Smartshop : analyse des commandes du réseau Interkab (produits, agences,
programme IK Solutions, carte, codes promo), avec import mensuel des fichiers et historique
des sauvegardes.

## Fonctionnement

- `index.html` est la page publiée par GitHub Pages. Elle ne contient **aucune donnée**.
- Les données (commandes, annuaire IK Solutions, catalogue, historique des sauvegardes) sont
  stockées dans Firebase (projet `smartshop-catalogues`, collections `interkab_base`,
  `interkab_datasets` et `interkab_history`).
- L'accès est réservé aux comptes Google de l'équipe, selon les règles Firestore.
- Chaque import fait depuis l'outil est visible par toute l'équipe à la prochaine actualisation.

## Mettre à jour l'outil

Remplacez `index.html` par la nouvelle version fournie, puis validez (Commit changes).
Les données dans Firebase ne sont pas modifiées.

## Confidentialité

Ne déposez jamais le fichier `interkab-donnees-initiales.json` ni de fichiers Excel de
commandes dans ce dépôt : ils contiennent les données du client.
