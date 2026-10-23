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

## Ajouter un réseau (ex. CAFPI)

Ajouter le préfixe dans `CLIENTS` (ex. `interkab,cafpi`) et les variables `WC_CAFPI_URL`, `WC_CAFPI_KEY`,
`WC_CAFPI_SECRET`, `WC_CAFPI_SINCE`, `WC_CAFPI_STATUSES`, et si besoin `WC_CAFPI_AGENCY`. Le préfixe doit être
celui des collections Firebase de l'outil (`cafpi_datasets`, …). La variable `CRON` vaut pour tous les réseaux de `CLIENTS`,
sauf ceux qui ont leur propre planification `WC_<PREFIXE>_CRON` (ex. `0 4 * * 1` : chaque lundi à 4 h UTC, 6 h à Paris en été).

`WC_<PREFIXE>_AGENCY` : `societe` (défaut) regroupe les commandes par société de facturation ; `email` regroupe par
personne (e-mail de facturation), avec le libellé « Prénom NOM (Ville) » de sa commande la plus récente. C'est le
réglage de CAFPI, dont les commandes sont passées par des courtiers et facturées presque toujours à « CAFPI ».
`livraison` regroupe par personne d'après le **nom de livraison** (prénom et nom, dans n'importe quel ordre, sans tenir
compte des accents), libellé « Prénom NOM » le plus fréquent. C'est le réglage de Mon Assurance Facile, dont toutes les
commandes sont facturées au même nom et livrées aux conseillers. Les noms génériques (mots de `WC_<PREFIXE>_GENERIC`,
ex. `FACILE,MASF`) sont regroupés par ville de livraison, sous le libellé `WC_<PREFIXE>_GENERIC_LABEL` (« Ma Santé Facile (Lille) »).

**Catalogue WooCommerce** (`WC_<PREFIXE>_CATALOGUE=1`, réseaux sans catalogue monday, ex. Mon Assurance Facile) : à chaque
synchronisation, tous les produits de la boutique, **publiés et désactivés** (brouillons, privés), sont enregistrés comme
catalogue de l'outil (statut « En ligne » ou « Désactivé ») ; les commandes prennent le nom actuel du produit (un produit
renommé reste une seule ligne) et les produits de même nom sont regroupés. Gammes : `WC_<PREFIXE>_FAMILIES`, JSON
{début de la catégorie principale → gamme} ; sous-gamme = région : `WC_<PREFIXE>_REGIONS`, JSON {code en fin de catégorie → région}.
Les produits supprimés de la boutique gardent la gamme fixée dans l'outil.
| Réseau | URL | SINCE | STATUSES | AGENCY |
|---|---|---|---|---|
| Interkab | `https://leshop.ma-boite-immo.com` | `2023-10-01` | `completed,processing` | (défaut) |
| CAFPI | `https://mygoodies.cafpi.fr` | `2025-04-01` | `completed,processing` | `email` |
| Mon Assurance Facile | `https://smartshop.monassurancefacile.com` | `2020-01-01` | `completed,processing` | `livraison` (+ catalogue) |

Variables de Mon Assurance Facile (préfixe `maf`, à ajouter dans `CLIENTS`) :

```
WC_MAF_URL=https://smartshop.monassurancefacile.com
WC_MAF_KEY=…            (clé API WooCommerce en lecture)
WC_MAF_SECRET=…
WC_MAF_SINCE=2020-01-01
WC_MAF_STATUSES=completed,processing
WC_MAF_AGENCY=livraison
WC_MAF_GENERIC=FACILE,MASF
WC_MAF_GENERIC_LABEL=Ma Santé Facile
WC_MAF_CATALOGUE=1
WC_MAF_FAMILIES={"GOODIES":"Goodies","PRINT":"Print","PLV":"PLV","Destockage":"Déstockage","Bibliothèque de prospection":"Bibliothèque de prospection"}
WC_MAF_REGIONS={"GO":"Grand-Ouest","GP":"Grand-Paris","HDF":"Hauts-de-France","SE":"Sud-Est","SO":"Sud-Ouest","SIEGE":"Siège"}
```

## Ce que fait une synchronisation

- Lecture de toutes les commandes aux statuts choisis depuis la date de départ (pas seulement les nouvelles :
  une commande passée en « annulée » ou « remboursée » disparaît ainsi de l'étude).
- Remboursements : une commande remboursée en totalité est écartée, même si son statut est resté « Terminée » ;
  un remboursement partiel est déduit des montants de la commande (produits, frais de port, TTC), au prorata.
- Pour chaque commande : numéro, date, CA HT produits (somme des lignes avant remise), TTC, remise,
  codes promo, lignes (produit, quantité, HT), code postal et ville de livraison, société de facturation (ou
  courtier en mode `email`),
  **frais de port HT**.
- Les produits gardent la famille et la sous-famille déjà connues dans l'outil ; les nouveaux produits, et ceux
  dont la famille est « Non renseignée », sont classés d'après leurs catégories WooCommerce. Le nom utilisé est celui du produit parent, pour que les
  déclinaisons (tailles, couleurs) restent regroupées comme dans les exports.
- Seul un compte de la liste `authorizedUsers` avec le rôle `editor` peut déclencher la synchronisation
  depuis l'outil (jeton de connexion vérifié côté serveur).

## En local

```
npm install
FIREBASE_SERVICE_ACCOUNT='…' CLIENTS=interkab WC_INTERKAB_URL=… WC_INTERKAB_KEY=… WC_INTERKAB_SECRET=… npm run sync
```


## API Origami (Orpi) : première étape

Orpi passe ses commandes sur la marketplace Origami, et non sur WooCommerce. Le service sait se connecter à l'API
Origami (OAuth, documentation : https://api-doc.origami-marketplace.com) pour préparer la synchronisation automatique.

Variables à ajouter dans Railway, **jamais dans ce dépôt** :

| Variable | Valeur |
|---|---|
| `ORIGAMI_URL` | `https://api-orpi.origami-marketplace.com` |
| `ORIGAMI_CLIENT_ID` | identifiant client fourni par Origami |
| `ORIGAMI_CLIENT_SECRET` | secret client fourni par Origami |
| `ORIGAMI_USERNAME` | e-mail du compte API |
| `ORIGAMI_PASSWORD` | mot de passe du compte API |

La route `GET /origami/apercu` (compte editor connecté, comme `/sync`) renvoie le compte API et les deux dernières
commandes avec leurs lignes, statut, adresses et remboursements : elle sert à vérifier les droits du compte et le format
réel des données avant d'écrire la synchronisation complète d'Orpi.
