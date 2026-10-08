# Étude des commandes – Réseau Interkab

Tableau de bord Smartshop : analyse des commandes du réseau Interkab, avec import mensuel
des fichiers et historique des sauvegardes.

Quatre sections, accessibles dans la barre latérale (ou la barre du bas sur mobile) :

- **Tableau de bord** : chiffres clés et leur évolution (dont CA après remises, commissions
  reversées, frais de port), objectifs annuels, points clés, graphiques (typologies, best sellers,
  agences les plus actives, fidélité, agences gagnées et perdues, saisonnalité, concentration du CA,
  nouveaux produits et vitesse d'adoption, produits en déclin ou en progression, produits achetés
  ensemble, efficacité des codes, catalogue vendu). Sous-vues : **Comparer deux périodes** et
  **Rapport mensuel** (imprimable / PDF).
- **Produits** : ventes par produit, renouvellement, produits jamais commandés, évolution par année.
- **Agences** : classement, carte, programme IK Solutions.
- **Codes promo**.

Un interrupteur en haut à droite active le mode sombre. Chaque page a un bouton
« Comment lire cette page », chaque tableau un bouton « Exporter en Excel », et la barre du haut
une recherche d'agence ou de produit. Les editors définissent les objectifs et le taux de
commission depuis « Mettre à jour les données » (commission Interkab : 9 % du CA HT après remises).

## Vue groupe

`groupe/index.html` consolide tous les réseaux clients (même connexion Google, mêmes droits).
Pour ajouter un réseau, ajoutez une ligne dans la liste `CLIENTS` en tête du fichier, avec le
préfixe de ses collections Firebase. Adresse : https://smartshop-ia.github.io/Analyse-LBI/groupe/

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
