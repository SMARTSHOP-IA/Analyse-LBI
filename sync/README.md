# Synchronisation WooCommerce → Étude des commandes

Petit service à déployer sur Railway. Il lit les commandes de la boutique WooCommerce d'un réseau,
les met au format de l'outil et les enregistre dans Firebase, exactement comme un import de fichier
(la version précédente est sauvegardée dans l'historique). L'outil propose alors le bouton
« Mettre à jour depuis WooCommerce » dans « Mettre à jour les données ».

Les clés (WooCommerce et Firebase) restent sur le serveur : elles ne sont jamais dans la page publique.

## Déploiement sur Railway (une fois)

1. Railway → **New Project** → **Deploy from GitHub repo** → choisir `SMARTSHOP-IA/Analyse-LBI`.
2. Dans le service créé : **Settings** → **Root Directory** : `sync` (le service vit dans ce sous-dossier).
3. **Variables** → ajouter :

| Variable | Valeur |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | le contenu complet du fichier JSON de clé de compte de service Firebase (console Firebase → Paramètres du projet → Comptes de service → « Générer une nouvelle clé privée ») |
| `CLIENTS` | `interkab` |
| `WC_INTERKAB_URL` | `https://leshop.ma-boite-immo.com` |
| `WC_INTERKAB_KEY` | la *consumer key* WooCommerce (WordPress → WooCommerce → Réglages → Avancé → API REST → Ajouter une clé, droits **Lecture**) |
| `WC_INTERKAB_SECRET` | le *consumer secret* de la même clé |
| `WC_INTERKAB_SINCE` | `2023-10-01` |
| `WC_INTERKAB_STATUSES` | `completed,processing` (statuts Terminée et En cours) |
| `CRON` | `0 4 * * *` pour une synchronisation automatique chaque nuit à 4 h UTC (6 h à Paris en été) ; laisser vide pour ne synchroniser qu'à la demande |

4. **Settings** → **Networking** → **Generate Domain** : noter l'adresse (`https://….up.railway.app`). Le **port cible** du domaine
   doit être celui sur lequel le service écoute (variable `PORT`, ex. 8888) ; sinon l'adresse répond « 502 Bad Gateway ».
   Service Interkab en place : `https://analyse-lbi-production.up.railway.app` (projet Railway « merry-enjoyment »).
5. Dans l'outil, connecté avec un compte editor : Mettre à jour les données → Objectifs et commission →
   **Synchronisation WooCommerce** → coller l'adresse → Enregistrer. Le bouton « Mettre à jour depuis
   WooCommerce » apparaît dans la carte Commandes.

Vérification : ouvrir l'adresse du service dans un navigateur ; elle répond `{"service":"smartshop-sync-woocommerce", …}`.

## Ajouter un réseau (ex. Orpi)

Ajouter `orpi` dans `CLIENTS` et les variables `WC_ORPI_URL`, `WC_ORPI_KEY`, `WC_ORPI_SECRET`,
`WC_ORPI_SINCE`, `WC_ORPI_STATUSES`. Le préfixe doit être celui des collections Firebase de l'outil
(`orpi_datasets`, …).

## Ce que fait une synchronisation

- Lecture de toutes les commandes aux statuts choisis depuis la date de départ (pas seulement les nouvelles :
  une commande passée en « annulée » ou « remboursée » disparaît ainsi de l'étude).
- Pour chaque commande : numéro, date, CA HT produits (somme des lignes avant remise), TTC, remise,
  codes promo, lignes (produit, quantité, HT), code postal et ville de livraison, société de facturation,
  **frais de port HT**.
- Les produits gardent la famille et la sous-famille déjà connues dans l'outil ; les nouveaux produits sont
  classés d'après leurs catégories WooCommerce. Le nom utilisé est celui du produit parent, pour que les
  déclinaisons (tailles, couleurs) restent regroupées comme dans les exports.
- Seul un compte de la liste `authorizedUsers` avec le rôle `editor` peut déclencher la synchronisation
  depuis l'outil (jeton de connexion vérifié côté serveur).

## En local

```
npm install
FIREBASE_SERVICE_ACCOUNT='…' CLIENTS=interkab WC_INTERKAB_URL=… WC_INTERKAB_KEY=… WC_INTERKAB_SECRET=… npm run sync
```
