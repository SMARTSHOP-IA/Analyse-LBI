/* Smartshop – synchronisation WooCommerce → Firebase
   Pour chaque réseau (préfixe), lit les commandes de la boutique WooCommerce via l'API REST, les met au format
   de l'outil « Étude des commandes » et les enregistre dans Firestore exactement comme un import de fichier
   (collection <prefixe>_datasets, sauvegarde de la version précédente dans <prefixe>_history).

   Variables d'environnement :
     FIREBASE_SERVICE_ACCOUNT   contenu JSON de la clé de compte de service Firebase
     CLIENTS                    liste des préfixes, séparés par des virgules (ex. "interkab,orpi")
     WC_<PREFIXE>_URL           adresse du site WooCommerce (ex. https://leshop.ma-boite-immo.com)
     WC_<PREFIXE>_KEY           consumer key (lecture)
     WC_<PREFIXE>_SECRET        consumer secret
     WC_<PREFIXE>_SINCE         première date à récupérer (ex. 2023-10-01)
     WC_<PREFIXE>_STATUSES      statuts comptés (défaut : completed,processing)
     WC_<PREFIXE>_AGENCY        regroupement des commandes : "societe" (défaut, société de facturation) ou "email"
                                (une agence = une personne, libellé « Prénom NOM (Ville) », ex. réseau de courtiers CAFPI)
                                ou "livraison" (une agence = la personne du nom de livraison, ex. conseillers Mon Assurance Facile)
     WC_<PREFIXE>_GENERIC       mode livraison : mots d'un nom générique (ex. "FACILE,MASF"), regroupé par ville de livraison
     WC_<PREFIXE>_GENERIC_LABEL mode livraison : libellé de ces commandes (ex. "Ma Santé Facile" → « Ma Santé Facile (Lille) »)
     WC_<PREFIXE>_CATALOGUE     "1" : les produits WooCommerce (publiés et désactivés) deviennent le catalogue de l'outil
     WC_<PREFIXE>_FAMILIES      JSON {"début de catégorie":"Famille"} (gammes des produits, mode catalogue)
     WC_<PREFIXE>_REGIONS       JSON {"code en fin de catégorie":"Région"} (sous-gamme = région, mode catalogue)
     WC_<PREFIXE>_CRON          planification propre à ce réseau (ex. "0 4 * * 1" : chaque lundi) ; il ne suit alors plus CRON
     CRON                       planification optionnelle, ex. "0 5 * * *" (tous les jours à 5 h, heure UTC)
     ORIGAMI_URL, ORIGAMI_CLIENT_ID, ORIGAMI_CLIENT_SECRET, ORIGAMI_USERNAME, ORIGAMI_PASSWORD (et ORIGAMI_CONTEXT, facultatif :
                                identifiant du groupe utilisateur vendeur ; sinon détecté depuis /v1/me)
                                accès à l'API Origami (marketplace Orpi) ; à saisir uniquement dans Railway, jamais dans le dépôt
     ALLOWED_ORIGINS            origines autorisées à appeler le service (défaut : https://smartshop-ia.github.io)
     PORT                       fourni par Railway
*/
import express from 'express';
import admin from 'firebase-admin';
import cron from 'node-cron';
import { buildCatalogue, renameLines, livraisonKey, pickLabels, parseJson } from './catalogue.js';
import { buildOrigamiDataset, fetchOrigami } from './origami.js';

const env = (k, d) => (process.env[k] ?? d);
const CLIENTS = env('CLIENTS', 'interkab').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ORIGINS = env('ALLOWED_ORIGINS', 'https://smartshop-ia.github.io').split(',').map(s => s.trim());
const CHUNK = 700;
const OG_PREFIX = env('ORIGAMI_PREFIX', 'orpi').toLowerCase(), OG_ON = () => !!env('ORIGAMI_URL', '');

/* ---------- Firebase ---------- */
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('FIREBASE_SERVICE_ACCOUNT manquant'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const fs = admin.firestore();
const docRef = (prefix, path) => { const s = path.split('/'); return fs.collection(prefix + '_' + s[0]).doc(s.slice(1).join('__')); };
async function readJson(prefix, path) { const d = await docRef(prefix, path).get(); return d.exists ? JSON.parse(d.data().json) : null; }
async function writeJson(prefix, path, obj, by) {
  const json = JSON.stringify(obj);
  if (json.length > 1000000) throw new Error('Document trop volumineux : ' + path);
  await docRef(prefix, path).set({ json, by, at: admin.firestore.FieldValue.serverTimestamp() });
}
async function writeBase(prefix, obj, by) {
  const text = JSON.stringify(obj), PART = 800000, n = Math.ceil(text.length / PART);
  for (let k = 0; k < n; k++) await fs.collection(prefix + '_base').doc('part_' + k).set({ s: text.slice(k * PART, (k + 1) * PART) });
  await fs.collection(prefix + '_base').doc('meta').set({ parts: n, size: text.length, by, at: admin.firestore.FieldValue.serverTimestamp() });
}
/* données de base d'un nouveau client, construites à partir de sa première synchronisation (même structure que preparer_outil.py) */
function makeBase(ds, catalogueItems, label, today) {
  const cat = catalogueItems || [], byName = new Map(cat.map((c, k) => [c[0], k])), used = new Set();
  const products = ds.products.map(p => { const k = byName.has(p[0]) ? byName.get(p[0]) : -1; if (k >= 0) used.add(k); return [p[0], p[1], p[2] || '', k, k >= 0 ? 'certain' : (cat.length ? 'supprime' : 'none')]; });
  const orders = ds.orders.map(r => ({ n: r[0], d: r[1], t: r[2], ttc: r[3], r: r[4], c: r[5], i: r[6], dp: r[7], cp: r[8], v: r[9], b: r[10], s: r[11] || 0 }));
  return { orders, products, prodcat: products.map(p => p[3] >= 0 ? cat[p[3]][0] : ''), agencies: [], agnet: [], agkeys: [], agnid: [], rejected: [], network: [],
    catalogue: cat.map((c, k) => [...c.slice(0, 5), used.has(k) ? 1 : 0]),
    meta: { commandes: { file: label, date: today, count: orders.length }, annuaire: { file: '', date: '', count: 0 }, catalogue: { file: cat.length ? label : 'aucun', date: cat.length ? today : '', count: cat.length } } };
}
async function readBase(prefix) {
  const m = await fs.collection(prefix + '_base').doc('meta').get(); if (!m.exists) return null;
  let s = ''; for (let k = 0; k < m.data().parts; k++) { const p = await fs.collection(prefix + '_base').doc('part_' + k).get(); if (!p.exists) throw new Error('Données de base incomplètes'); s += p.data().s; }
  return JSON.parse(s);
}

/* ---------- mêmes règles que l'outil ---------- */
const titleCase = s => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const padCp = v => { if (v == null || v === '') return ''; const n = Math.round(Number(String(v).replace(/\s/g, ''))); return isFinite(n) && n > 0 ? String(n).padStart(5, '0') : ''; };
const depOf = cp => !cp ? '' : cp.startsWith('97') ? cp.slice(0, 3) : cp.startsWith('98') ? 'MC' : cp.startsWith('20') ? (+cp < 20200 ? '2A' : '2B') : cp.slice(0, 2);
const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', deg: '°', euro: '€', hellip: '…', trade: '™', reg: '®', copy: '©' };
const decode = s => String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
const normKey = s => decode(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const FIXN = { 'Calendrier 2024 A5250 gr': 'Calendrier 2024 A5 250 gr', 'Panneau Agence personnalisable 80x60 cm r/v': 'Panneau agence personnalisable 80x60 cm r/v' };
const PRIO = ['PLV / Signalétique', 'Papeterie', 'Textile', 'Goodies', 'Matériel', 'Label Interkab', "Produit d'Été ☀️", 'Produits RSE', 'Les incontournables', 'Temps forts'];
function famOf(s) {
  if (!s || !String(s).trim()) return ['Non renseignée', ''];
  const toks = String(s).split(',').map(x => x.trim()).filter(Boolean), fams = toks.map(x => x.split('>')[0].trim());
  let f = fams[0]; fams.forEach(x => { const a = PRIO.indexOf(x), b = PRIO.indexOf(f); if (a >= 0 && (b < 0 || a < b)) f = x; });
  const sub = toks.filter(x => x.includes('>') && x.split('>')[0].trim() === f).map(x => x.split('>')[1].trim())[0] || '';
  return [f.replace(' ☀️', ''), sub];
}
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(num(v) * 100) / 100;
const fmtDate = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : ''; };

/* ---------- WooCommerce ---------- */
function shopConfig(prefix) {
  const P = prefix.toUpperCase(), url = env(`WC_${P}_URL`), key = env(`WC_${P}_KEY`), secret = env(`WC_${P}_SECRET`);
  if (!url || !key || !secret) throw new Error(`Configuration WooCommerce manquante pour « ${prefix} » (WC_${P}_URL / KEY / SECRET).`);
  return { url: url.replace(/\/wp-admin\/?$/, '').replace(/\/$/, ''), key, secret, since: env(`WC_${P}_SINCE`, '2023-10-01'), statuses: env(`WC_${P}_STATUSES`, 'completed,processing'), agency: env(`WC_${P}_AGENCY`, 'societe').toLowerCase(),
    catalogue: /^(1|true|oui|yes)$/i.test(env(`WC_${P}_CATALOGUE`, '')), families: parseJson(env(`WC_${P}_FAMILIES`, ''), `WC_${P}_FAMILIES`), regions: parseJson(env(`WC_${P}_REGIONS`, ''), `WC_${P}_REGIONS`),
    generic: env(`WC_${P}_GENERIC`, '').split(',').map(s => s.trim()).filter(Boolean), genericLabel: env(`WC_${P}_GENERIC_LABEL`, '') };
}
async function wcGetAll(cfg, path, params = {}) {
  const out = []; let page = 1;
  for (;;) {
    const u = new URL(cfg.url + '/wp-json/wc/v3/' + path);
    Object.entries({ per_page: 100, page, ...params }).forEach(([k, v]) => u.searchParams.set(k, v));
    const res = await fetch(u, { headers: { Authorization: 'Basic ' + Buffer.from(cfg.key + ':' + cfg.secret).toString('base64'), Accept: 'application/json' } });
    if (!res.ok) throw new Error(`WooCommerce ${path} : HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
    const rows = await res.json(); out.push(...rows);
    const total = +(res.headers.get('x-wp-totalpages') || 1);
    if (page >= total || !rows.length) break; page++;
  }
  return out;
}
async function fetchShop(cfg) {
  const [cats, products, orders] = await Promise.all([
    wcGetAll(cfg, 'products/categories', { hide_empty: false }),
    wcGetAll(cfg, 'products', { status: 'any' }),
    wcGetAll(cfg, 'orders', { status: cfg.statuses, after: cfg.since + 'T00:00:00', orderby: 'date', order: 'asc' })
  ]);
  const catById = new Map(cats.map(c => [c.id, c]));
  const catPath = c => { const p = c.parent && catById.get(c.parent); return p ? p.name + '>' + c.name : c.name; };
  const prodCats = new Map(products.map(p => [p.id, (p.categories || []).map(c => catById.get(c.id) ? catPath(catById.get(c.id)) : c.name).join(', ')]));
  if (cfg.catalogue) {
    // catalogue complet (produits publiés et désactivés) ; les commandes prennent le nom actuel des produits
    const cat = buildCatalogue(products, cats, orders, cfg);
    renameLines(orders, cat.nameOf);
    return { orders, prodCats: cat.catOf, catalogue: cat.items };
  }
  return { orders, prodCats };
}

/* ---------- transformation au format de l'outil ---------- */
// mode « email » : libellé d'un courtier, même règle que preparer_outil.py
const courtierLabel = (first, last, city, email) => {
  const name = (titleCase(decode(first).trim()) + ' ' + decode(last).trim().toUpperCase()).replace(/\s+/g, ' ').trim() || String(email).split('@')[0];
  const c = decode(city).replace(/^\d{4,5}\s*-?\s*/, '').trim();
  return name + (c ? ' (' + titleCase(c) + ')' : '');
};
function buildDataset(prefix, { orders, prodCats }, prevProducts, agency = 'societe', cfg = {}) {
  const keyed = [], keyedL = [];
  const prodList = [], pidx = new Map(), prodCatCount = new Map(), out = [];
  // noms déjà connus dans l'outil : on les retrouve même si l'API les écrit un peu différemment (espaces, accents, guillemets)
  const prevByKey = new Map((prevProducts || []).map(p => [normKey(p[0]), p[0]]));
  for (const o of orders) {
    const n = Number(o.number || o.id); if (!isFinite(n) || !n) continue;
    // remboursements : une commande remboursée en totalité est écartée ; un remboursement partiel est déduit au prorata
    const totalTTC = num(o.total), refunded = (o.refunds || []).reduce((s, r) => s + Math.abs(num(r.total)), 0);
    if (refunded > 0 && refunded >= totalTTC - 0.01) continue;
    const kr = refunded > 0 && totalTTC > 0 ? 1 - refunded / totalTTC : 1;
    const bill = o.billing || {}, ship = o.shipping || {};
    const cp = padCp(ship.postcode || bill.postcode), soc = decode(bill.company || '').replace(/\s+/g, ' ').trim().toUpperCase() || '(SANS NOM)';
    const items = [];
    for (const li of (o.line_items || [])) {
      let name = decode(li.parent_name || li.name || '').replace(/[​\s]+/g, ' ').trim() || '(Produit sans nom / supprimé)'; name = FIXN[name] || name;
      name = prevByKey.get(normKey(name)) || name;
      if (!pidx.has(name)) { pidx.set(name, prodList.length); prodList.push(name); }
      const p = pidx.get(name), cat = prodCats.get(li.product_id) || '';
      if (cat) { const f = famOf(cat).join('|'); const m = prodCatCount.get(p) || new Map(); m.set(f, (m.get(f) || 0) + 1); prodCatCount.set(p, m); }
      items.push([p, Math.round(num(li.quantity)), r2(num(li.subtotal) * kr)]);
    }
    const t = r2(items.reduce((s, i) => s + i[2], 0));
    const codes = (o.coupon_lines || []).filter(c => c.code).map(c => [String(c.code).trim().toLowerCase(), r2(c.discount)]);
    out.push([n, fmtDate(o.date_created), t, r2(totalTTC - refunded), r2(num(o.discount_total) * kr), codes, items, depOf(cp), cp, titleCase(decode(ship.city || bill.city || '').trim()), soc, r2(num(o.shipping_total) * kr)]);
    const mail = String(bill.email || '').trim().toLowerCase() || soc;
    keyed.push([mail, courtierLabel(bill.first_name, bill.last_name, ship.city || bill.city, mail)]);
    if (agency === 'livraison') keyedL.push(livraisonKey(o, cfg));
  }
  if (agency === 'livraison') {
    // une personne = son nom de livraison (prénom et nom dans n'importe quel ordre, sans accents) ; libellé le plus fréquent
    const labels = pickLabels(keyedL, out.map(o => o[1]));
    out.forEach((o, k) => { o[10] = labels[k]; });
  }
  if (agency === 'email') {
    // le libellé retenu pour une personne est celui de sa commande la plus récente
    const last = new Map(); out.map((o, k) => [o[1], k]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).forEach(([, k]) => last.set(keyed[k][0], keyed[k][1]));
    out.forEach((o, k) => { o[10] = last.get(keyed[k][0]); });
  }
  const prev = new Map((prevProducts || []).map(p => [p[0], p]));
  const products = prodList.map((name, p) => {
    const m = prodCatCount.get(p); const best = m ? [...m].sort((a, b) => b[1] - a[1])[0][0].split('|') : ['Non renseignée', ''];
    const pv = prev.get(name); if (pv && pv[1] && pv[1] !== 'Non renseignée') return [name, pv[1], pv[2]];
    return [name, best[0], best[1]]; });
  const unknown = prodList.filter(n => !prev.has(n));
  return { orders: out.filter(o => o[1]), products, unknown };
}

/* ---------- enregistrement (identique à l'outil) ---------- */
async function saveOrders(prefix, doc, by) {
  const chunks = []; for (let i = 0; i < doc.orders.length; i += CHUNK) chunks.push(doc.orders.slice(i, i + CHUNK));
  const prevMeta = await readJson(prefix, 'datasets/commandes'); const prevChunks = prevMeta ? prevMeta.chunks || 0 : 0;
  for (let k = 0; k < chunks.length; k++) await writeJson(prefix, 'datasets/commandes_' + k, { orders: chunks[k] }, by);
  await writeJson(prefix, 'datasets/commandes', { file: doc.file, date: doc.date, count: doc.orders.length, chunks: chunks.length, products: doc.products }, by);
  for (let k = chunks.length; k < prevChunks; k++) { try { await docRef(prefix, 'datasets/commandes_' + k).delete(); } catch (e) { } }
}
async function backupOrders(prefix, by) {
  const idx = (await readJson(prefix, 'history/index')) || { items: [] }, items = idx.items || [];
  const meta = await readJson(prefix, 'datasets/commandes');
  const entry = { id: 'orders-' + Date.now(), kind: 'orders', savedAt: new Date().toISOString(), by };
  if (!meta) { if (items.some(x => x.kind === 'orders' && x.origin)) return null; Object.assign(entry, { origin: true, file: 'fichier d\'origine', date: '', count: 0, metrics: {} }); }
  else {
    const orders = []; for (let k = 0; k < meta.chunks; k++) { const c = await readJson(prefix, 'datasets/commandes_' + k); if (!c) throw new Error('Jeu de données actuel incomplet'); orders.push(...c.orders); }
    const ch = []; for (let i = 0; i < orders.length; i += CHUNK) ch.push(orders.slice(i, i + CHUNK));
    for (let k = 0; k < ch.length; k++) await writeJson(prefix, 'history/' + entry.id + '_' + k, { orders: ch[k] }, by);
    await writeJson(prefix, 'history/' + entry.id, { file: meta.file, date: meta.date, count: meta.count, chunks: ch.length, products: meta.products }, by);
    const last = orders.reduce((m, o) => o[1] > m ? o[1] : m, '');
    Object.assign(entry, { file: meta.file, date: meta.date, count: meta.count, chunks: ch.length, metrics: { cmd: orders.length, ca: Math.round(orders.reduce((s, o) => s + o[2], 0)), ag: new Set(orders.map(o => o[10])).size, last: last.slice(0, 10) } });
  }
  await writeJson(prefix, 'history/index', { items: [entry, ...items] }, by);
  return entry;
}

const running = new Set();
async function syncClient(prefix, by = 'synchronisation automatique', { dryRun = false } = {}) {
  if (!CLIENTS.includes(prefix)) throw new Error(`Réseau inconnu : ${prefix}`);
  if (running.has(prefix)) throw new Error('Une synchronisation est déjà en cours.');
  running.add(prefix);
  try {
    const cfg = shopConfig(prefix), t0 = Date.now();
    const shop = await fetchShop(cfg);
    const base = await readBase(prefix), prevMeta = await readJson(prefix, 'datasets/commandes');
    const prevProducts = prevMeta ? prevMeta.products : (base ? base.products : []);
    const ds = buildDataset(prefix, shop, prevProducts, cfg.agency, cfg);
    if (!ds.orders.length) throw new Error('Aucune commande renvoyée par WooCommerce : rien n\'a été modifié.');
    const today = new Date().toISOString().slice(0, 10);
    const prevCount = prevMeta ? prevMeta.count : (base ? base.orders.length : 0);
    if (dryRun) {
      const years = {}; ds.orders.forEach(o => { const y = o[1].slice(0, 4); years[y] = years[y] || { commandes: 0, caProduitsHT: 0, port: 0 }; years[y].commandes++; years[y].caProduitsHT = Math.round((years[y].caProduitsHT + o[2]) * 100) / 100; years[y].port = Math.round((years[y].port + (o[11] || 0)) * 100) / 100; });
      const fams = {}; ds.products.forEach(p => { fams[p[1]] = (fams[p[1]] || 0) + 1; });
      const ags = {}; ds.orders.forEach(o => { ags[o[10]] = (ags[o[10]] || 0) + 1; });
      return { ok: true, dryRun: true, prefix, count: ds.orders.length, previous: prevCount, baseExiste: !!base, last: ds.orders.reduce((m, o) => o[1] > m ? o[1] : m, ''), annees: years,
        gammes: fams, agences: Object.keys(ags).length, topAgences: Object.entries(ags).sort((a, b) => b[1] - a[1]).slice(0, 10),
        catalogue: shop.catalogue ? { count: shop.catalogue.length, online: shop.catalogue.filter(c => c[3] === 'En ligne').length } : null };
    }
    // nouveau client : les données de base sont créées à partir de cette première lecture (pas de fichier à importer)
    if (!base) await writeBase(prefix, makeBase(ds, shop.catalogue, 'WooCommerce (lecture du ' + today + ')', today), by);
    await backupOrders(prefix, by);
    await saveOrders(prefix, { file: 'WooCommerce (synchronisation du ' + today + ')', date: today, orders: ds.orders, products: ds.products }, by);
    if (shop.catalogue) await writeJson(prefix, 'datasets/catalogue', { file: 'WooCommerce (synchronisation du ' + today + ')', date: today, items: shop.catalogue }, by);
    const last = ds.orders.reduce((m, o) => o[1] > m ? o[1] : m, '');
    return { ok: true, prefix, count: ds.orders.length, previous: prevCount, delta: ds.orders.length - prevCount, last, unknownProducts: ds.unknown.slice(0, 30), unknownCount: ds.unknown.length, catalogue: shop.catalogue ? { count: shop.catalogue.length, online: shop.catalogue.filter(c => c[3] === 'En ligne').length } : null, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } finally { running.delete(prefix); }
}

/* ---------- serveur ---------- */
const app = express();
app.use((req, res, next) => {
  const o = req.headers.origin; if (o && ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204); next();
});
const ownCron = c => env(`WC_${c.toUpperCase()}_CRON`, '');
app.get('/', (req, res) => res.json({ service: 'smartshop-sync-woocommerce', clients: CLIENTS, origami: OG_ON() ? OG_PREFIX : null, cron: env('CRON', '') || null, cronByClient: Object.fromEntries(CLIENTS.filter(ownCron).map(c => [c, ownCron(c)])) }));
app.post('/sync/:prefix', async (req, res) => {
  const prefix = String(req.params.prefix || '').toLowerCase();
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return res.status(401).json({ error: 'Connexion requise.' });
    const tok = await admin.auth().verifyIdToken(m[1]); const email = (tok.email || '').toLowerCase();
    const u = await fs.collection('authorizedUsers').doc(email).get();
    if (!u.exists || u.data().role !== 'editor') return res.status(403).json({ error: `Le compte ${email} n'a pas le rôle editor.` });
    res.json(prefix === OG_PREFIX && OG_ON() ? await syncOrigami(email) : await syncClient(prefix, email));
  } catch (e) { console.error(e); res.status(e.message && /déjà en cours/.test(e.message) ? 409 : 500).json({ error: e.message || String(e) }); }
});

/* ---------- Origami (Orpi) : connexion à l'API et aperçu, avant la synchronisation automatique ---------- */
let ogTok = null;
async function origamiToken() {
  const url = env('ORIGAMI_URL', '').replace(/\/$/, '');
  if (!url || !env('ORIGAMI_CLIENT_ID') || !env('ORIGAMI_CLIENT_SECRET') || !env('ORIGAMI_USERNAME') || !env('ORIGAMI_PASSWORD'))
    throw new Error('Variables ORIGAMI_URL, ORIGAMI_CLIENT_ID, ORIGAMI_CLIENT_SECRET, ORIGAMI_USERNAME et ORIGAMI_PASSWORD à renseigner dans Railway.');
  if (ogTok && ogTok.exp > Date.now() + 60000) return { url, token: ogTok.v };
  const body = new URLSearchParams({ grant_type: 'password', client_id: env('ORIGAMI_CLIENT_ID'), client_secret: env('ORIGAMI_CLIENT_SECRET'), username: env('ORIGAMI_USERNAME'), password: env('ORIGAMI_PASSWORD') });
  const r = await fetch(url + '/oauth/token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Connexion à l'API Origami refusée (HTTP ${r.status}${j.message ? ' : ' + j.message : j.error ? ' : ' + j.error : ''}).`);
  ogTok = { v: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return { url, token: ogTok.v };
}
async function origamiGet(path, params = {}, context = null) {
  const { url, token } = await origamiToken();
  const q = new URLSearchParams(params).toString();
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + token };
  if (context) headers.context = String(context);
  const r = await fetch(url + path + (q ? '?' + q : ''), { headers });
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (!r.ok) throw new Error(`API Origami ${path} : HTTP ${r.status} ${(j && (j.message || j.error)) || txt.slice(0, 200)}`);
  return j;
}
// champs et structure renvoyés par l'API (2 dernières commandes), pour construire la synchronisation sur les vrais formats
// groupe utilisateur (en-tête « context ») : ORIGAMI_CONTEXT, sinon le groupe vendeur du compte API
async function origamiContext() {
  if (env('ORIGAMI_CONTEXT')) return { id: env('ORIGAMI_CONTEXT'), groupes: null };
  const me = await origamiGet('/v1/me', { include: 'user_groups' });
  const d = me && me.data || {}, raw = d.user_groups || d.userGroups || [];
  const groupes = (Array.isArray(raw) ? raw : raw.data || []).map(g => ({ id: g.id, nom: g.name || g.label || null, type: g.type || g.user_group_type || null, champs: Object.keys(g) }));
  const vendeur = groupes.find(g => /seller|vendeur/i.test(String(g.type || '') + ' ' + String(g.nom || ''))) || groupes.find(g => /smart/i.test(String(g.nom || ''))) || groupes[0];
  return { id: vendeur ? vendeur.id : null, groupes };
}
async function origamiApercu() {
  const out = {};
  try { const me = await origamiGet('/v1/me'); const d = me && me.data || {}; out.compte = { id: d.id, email: d.email, champs: Object.keys(d) }; } catch (e) { out.compte = { erreur: e.message }; }
  let ctx = null;
  try { const c = await origamiContext(); ctx = c.id; out.context = c; } catch (e) { out.context = { erreur: e.message }; }
  const inc = 'state,orderLines,shippingAddress,billingAddress,refunds,fees';
  try {
    const o = await origamiGet('/v1/orders', { 'page[size]': '2', 'page[number]': '1', 'order[name]': 'id', 'order[way]': 'desc', include: inc }, ctx);
    out.commandes = { meta: o.meta || null, links: o.links ? Object.keys(o.links) : null, exemples: o.data || o };
  } catch (e) { out.commandes = { erreur: e.message }; }
  try { const l = await origamiGet('/v1/orders/lines', { 'page[size]': '2', 'order[name]': 'id', 'order[way]': 'desc', include: 'product' }, ctx); out.lignes = { meta: l.meta || null, exemples: l.data || l }; }
  catch (e) { out.lignes = { erreur: e.message }; }
  return out;
}
async function requireEditor(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) { const e = new Error('Connexion requise.'); e.status = 401; throw e; }
  const tok = await admin.auth().verifyIdToken(m[1]); const email = (tok.email || '').toLowerCase();
  const u = await fs.collection('authorizedUsers').doc(email).get();
  if (!u.exists || u.data().role !== 'editor') { const e = new Error(`Le compte ${email} n'a pas le rôle editor.`); e.status = 403; throw e; }
  return email;
}
// lecture seule d'une route /v1/… de l'API Origami (exploration des formats ; comptes editor uniquement)
app.get('/origami/lecture', async (req, res) => {
  try {
    await requireEditor(req);
    const path = String(req.query.path || '');
    if (!/^\/v1\/[a-z0-9_\/-]+$/i.test(path)) return res.status(400).json({ error: 'Paramètre path invalide (ex. /v1/orders).' });
    const params = {}; for (const [k, v] of Object.entries(req.query)) if (k !== 'path') params[k] = String(v);
    const c = await origamiContext();
    res.json(await origamiGet(path, params, c.id));
  } catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message || String(e) }); }
});
/* synchronisation Orpi depuis l'API Origami ; dryRun : calcule sans rien enregistrer */
async function syncOrigami(by = 'synchronisation automatique', { dryRun = false } = {}) {
  const prefix = OG_PREFIX;
  if (!OG_ON()) throw new Error('API Origami non configurée (variables ORIGAMI_* dans Railway).');
  if (running.has(prefix)) throw new Error('Une synchronisation est déjà en cours.');
  running.add(prefix);
  try {
    const t0 = Date.now(), ctx = (await origamiContext()).id;
    const base = await readBase(prefix); if (!base || !base.origami) throw new Error('Données de base Orpi introuvables (orpi_base, champ « origami »).');
    const prevMeta = await readJson(prefix, 'datasets/commandes');
    const prevProducts = prevMeta ? prevMeta.products : base.products.map(p => [p[0], p[1], p[2]]);
    const shop = await fetchOrigami(origamiGet, ctx, { pidmap: base.origami.pidmap });
    const ds = buildOrigamiDataset(shop.orders, { og: base.origami, products: shop.products, categories: shop.categories, prevProducts, knownAgencies: new Set(base.orders.map(o => o.b)) });
    if (!ds.orders.length) throw new Error('Aucune commande retenue depuis l\'API Origami : rien n\'a été modifié.');
    const today = new Date().toISOString().slice(0, 10), last = ds.orders.reduce((m, o) => o[1] > m ? o[1] : m, '');
    const prevCount = prevMeta ? prevMeta.count : base.orders.length;
    const summary = { ok: true, prefix, source: 'origami', count: ds.orders.length, previous: prevCount, delta: ds.orders.length - prevCount, last,
      apiOrders: shop.orders.length, skipped: ds.skipped, missingProducts: shop.missingProducts, seconds: Math.round((Date.now() - t0) / 1000),
      unknownProducts: ds.unknownProducts.slice(0, 30), unknownCount: ds.unknownProducts.length, unknownAgencies: ds.unknownAgencies.slice(0, 30) };
    if (dryRun) {
      const month = m => { const os = ds.orders.filter(o => o[1].startsWith(m)); return { commandes: os.length, caProduitsHT: Math.round(os.reduce((s, o) => s + o[2], 0) * 100) / 100, caEncaisseHT: Math.round(os.reduce((s, o) => s + o[2] - o[4] + o[11], 0) * 100) / 100 }; };
      const cut = base.orders.reduce((m, o) => o.d > m ? o.d : m, '');
      return { ...summary, dryRun: true, octobre2026: month('2026-10'), septembre2026: month('2026-09'),
        jusquAuDernierImport: { date: cut, api: ds.orders.filter(o => o[1] <= cut).length, outil: base.orders.length } };
    }
    await backupOrders(prefix, by);
    await saveOrders(prefix, { file: 'Origami (synchronisation du ' + today + ')', date: today, orders: ds.orders, products: ds.products }, by);
    return summary;
  } finally { running.delete(prefix); }
}
app.get('/test/:prefix', async (req, res) => {
  try { await requireEditor(req); res.json(await syncClient(String(req.params.prefix || '').toLowerCase(), 'test', { dryRun: true })); }
  catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message || String(e) }); }
});
app.get('/origami/test', async (req, res) => {
  try { await requireEditor(req); res.json(await syncOrigami('test', { dryRun: true })); }
  catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message || String(e) }); }
});
app.get('/origami/apercu', async (req, res) => {
  try { await requireEditor(req); res.json(await origamiApercu()); }
  catch (e) { console.error(e); res.status(e.status || 500).json({ error: e.message || String(e) }); }
});

const once = process.argv.includes('--once');
if (once) { (async () => { for (const c of CLIENTS) { try { console.log(JSON.stringify(await syncClient(c))); } catch (e) { console.error(c, e.message); process.exitCode = 1; } } process.exit(); })(); }
else {
  // CRON vaut pour les réseaux sans planification propre ; WC_<PREFIXE>_CRON (ex. hebdomadaire) pour les autres
  const shared = CLIENTS.filter(c => !ownCron(c));
  if (env('CRON', '') && (shared.length || OG_ON())) cron.schedule(env('CRON'), async () => {
    for (const c of shared) { try { console.log('cron', JSON.stringify(await syncClient(c))); } catch (e) { console.error('cron', c, e.message); } }
    if (OG_ON()) { try { console.log('cron', OG_PREFIX, JSON.stringify(await syncOrigami())); } catch (e) { console.error('cron', OG_PREFIX, e.message); } }
  });
  for (const c of CLIENTS.filter(ownCron)) cron.schedule(ownCron(c), async () => { try { console.log('cron', c, JSON.stringify(await syncClient(c))); } catch (e) { console.error('cron', c, e.message); } });
  app.listen(+env('PORT', 3000), () => console.log('smartshop-sync-woocommerce prêt, réseaux :', CLIENTS.join(', ')));
}
