# Étude des commandes – tous les clients Smartshop

Tableau de bord Smartshop : analyse des commandes de chaque client (Interkab, Orpi, CAFPI, Mon Assurance Facile),
dans un seul outil : https://smartshop-ia.github.io/Analyse-LBI/

Le menu déroulant **Client**, en haut de la barre latérale (en haut de l'écran sur mobile), passe d'un client à l'autre.
L'adresse indique le client affiché (`?client=orpi`), ce qui permet de partager un lien direct ; sans précision, l'outil
rouvre le dernier client consulté. Le lien « Vue groupe » consolide tous les clients.

Les commandes de chaque client sont synchronisées chaque nuit (Railway, variable `CRON`), sauf Orpi tant que
la synchronisation Origami n'est pas branchée (import des exports Origami).

Les modules propres à un client s'activent selon ses données : programme IK Solutions (Interkab, si l'annuaire est importé),
import des exports Origami et commissions réelles (Orpi), statut « Désactivé » des produits du catalogue WooCommerce (MAF).

**Ajouter un client** : une ligne dans la liste `SS_CLIENTS` en tête de `index.html` (identifiant = préfixe des collections
Firebase, nom, taux de commission par défaut, logo), et la même dans `CLIENTS` de `groupe/index.html`. Les règles Firestore
et la synchronisation WooCommerce se règlent comme avant (voir `sync/README.md`).

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
une recherche d'agence ou de produit. Le bouton « Poser une question », en bas à droite, ouvre un
assistant qui répond en français à partir des données (meilleure agence, produit le plus vendu,
département le plus actif, CA d'une période, codes promo, comparaison de deux années…). Les editors définissent les objectifs et le taux de
commission depuis « Mettre à jour les données » (commission Interkab : 9 % du CA HT après remises, hors frais de port).

## Export client (lien privé)

La section **Export client** de l'outil publie un tableau de bord simplifié pour le réseau
(CA, commandes, paniers, tops agences et produits, répartition par gamme, évolution mensuelle),
lisible sans compte à l'adresse `client/index.html?c=<client>&k=<clé>`. La clé est générée par un
editor dans l'outil (« Créer le lien client ») et peut être régénérée pour couper l'accès. Le tableau
est republié automatiquement à chaque import de données. Les données sont stockées dans la collection
`<client>_client` (ex. `interkab_client`) : ajoutez le contenu de `regles-firestore-client.txt` aux règles Firestore
(avant les deux dernières accolades), sinon la publication échoue.

## Vue groupe

`groupe/index.html` consolide tous les réseaux clients (même connexion Google, mêmes droits). Adresse : https://smartshop-ia.github.io/Analyse-LBI/groupe/

## Fonctionnement

- `index.html` est la page publiée par GitHub Pages. Elle ne contient **aucune donnée**.
- Les données (commandes, annuaire IK Solutions, catalogue, historique des sauvegardes) sont
  stockées dans Firebase (projet `smartshop-catalogues`), dans les collections de chaque client :
  `interkab_…`, `orpi_…`, `cafpi_…`, `maf_…` (`_base`, `_datasets`, `_history`, `_client`).
- L'accès est réservé aux comptes Google de l'équipe, selon les règles Firestore.
- Chaque import fait depuis l'outil est visible par toute l'équipe à la prochaine actualisation.

## Mettre à jour l'outil

Remplacez `index.html` par la nouvelle version fournie, puis validez (Commit changes).
Les données dans Firebase ne sont pas modifiées.

## Confidentialité

Ne déposez jamais de fichier `donnees-initiales.json`, d'exports Origami ni de fichiers Excel de
commandes dans ce dépôt : ils contiennent les données du client.
