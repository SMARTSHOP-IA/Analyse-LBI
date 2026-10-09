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
     CRON                       planification optionnelle, ex. "0 5 * * *" (tous les jours à 5 h, heure UTC)
     ALLOWED_ORIGINS            origines autorisées à appeler le service (défaut : https://smartshop-ia.github.io)
     PORT                       fourni par Railway
*/
import express from 'express';
import admin from 'firebase-admin';
import cron from 'node-cron';

const env = (k, d) => (process.env[k] ?? d);
const CLIENTS = env('CLIENTS', 'interkab').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ORIGINS = env('ALLOWED_ORIGINS', 'https://smartshop-ia.github.io').split(',').map(s => s.trim());
const CHUNK = 700;

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
  return { url: url.replace(/\/wp-admin\/?$/, '').replace(/\/$/, ''), key, secret, since: env(`WC_${P}_SINCE`, '2023-10-01'), statuses: env(`WC_${P}_STATUSES`, 'completed,processing') };
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
  return { orders, prodCats };
}

/* ---------- transformation au format de l'outil ---------- */
function buildDataset(prefix, { orders, prodCats }, prevProducts) {
  const prodList = [], pidx = new Map(), prodCatCount = new Map(), out = [];
  // noms déjà connus dans l'outil : on les retrouve même si l'API les écrit un peu différemment (espaces, accents, guillemets)
  const prevByKey = new Map((prevProducts || []).map(p => [normKey(p[0]), p[0]]));
  for (const o of orders) {
    const n = Number(o.number || o.id); if (!isFinite(n) || !n) continue;
    const bill = o.billing || {}, ship = o.shipping || {};
    const cp = padCp(ship.postcode || bill.postcode), soc = decode(bill.company || '').replace(/\s+/g, ' ').trim().toUpperCase() || '(SANS NOM)';
    const items = [];
    for (const li of (o.line_items || [])) {
      let name = decode(li.parent_name || li.name || '').replace(/[​\s]+/g, ' ').trim() || '(Produit sans nom / supprimé)'; name = FIXN[name] || name;
      name = prevByKey.get(normKey(name)) || name;
      if (!pidx.has(name)) { pidx.set(name, prodList.length); prodList.push(name); }
      const p = pidx.get(name), cat = prodCats.get(li.product_id) || '';
      if (cat) { const f = famOf(cat).join('|'); const m = prodCatCount.get(p) || new Map(); m.set(f, (m.get(f) || 0) + 1); prodCatCount.set(p, m); }
      items.push([p, Math.round(num(li.quantity)), r2(li.subtotal)]);
    }
    const t = r2(items.reduce((s, i) => s + i[2], 0));
    const codes = (o.coupon_lines || []).filter(c => c.code).map(c => [String(c.code).trim().toLowerCase(), r2(c.discount)]);
    out.push([n, fmtDate(o.date_created), t, r2(o.total), r2(o.discount_total), codes, items, depOf(cp), cp, titleCase(decode(ship.city || bill.city || '').trim()), soc, r2(o.shipping_total)]);
  }
  const prev = new Map((prevProducts || []).map(p => [p[0], p]));
  const products = prodList.map((name, p) => { const pv = prev.get(name); if (pv) return [name, pv[1], pv[2]];
    const m = prodCatCount.get(p); const best = m ? [...m].sort((a, b) => b[1] - a[1])[0][0].split('|') : ['Non renseignée', '']; return [name, best[0], best[1]]; });
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
async function syncClient(prefix, by = 'synchronisation automatique') {
  if (!CLIENTS.includes(prefix)) throw new Error(`Réseau inconnu : ${prefix}`);
  if (running.has(prefix)) throw new Error('Une synchronisation est déjà en cours.');
  running.add(prefix);
  try {
    const cfg = shopConfig(prefix), t0 = Date.now();
    const shop = await fetchShop(cfg);
    const base = await readBase(prefix), prevMeta = await readJson(prefix, 'datasets/commandes');
    const prevProducts = prevMeta ? prevMeta.products : (base ? base.products : []);
    const ds = buildDataset(prefix, shop, prevProducts);
    if (!ds.orders.length) throw new Error('Aucune commande renvoyée par WooCommerce : rien n\'a été modifié.');
    const today = new Date().toISOString().slice(0, 10);
    const prevCount = prevMeta ? prevMeta.count : (base ? base.orders.length : 0);
    await backupOrders(prefix, by);
    await saveOrders(prefix, { file: 'WooCommerce (synchronisation du ' + today + ')', date: today, orders: ds.orders, products: ds.products }, by);
    const last = ds.orders.reduce((m, o) => o[1] > m ? o[1] : m, '');
    return { ok: true, prefix, count: ds.orders.length, previous: prevCount, delta: ds.orders.length - prevCount, last, unknownProducts: ds.unknown.slice(0, 30), unknownCount: ds.unknown.length, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  } finally { running.delete(prefix); }
}

/* ---------- serveur ---------- */
const app = express();
app.use((req, res, next) => {
  const o = req.headers.origin; if (o && ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204); next();
});
app.get('/', (req, res) => res.json({ service: 'smartshop-sync-woocommerce', clients: CLIENTS, cron: env('CRON', '') || null }));
app.post('/sync/:prefix', async (req, res) => {
  const prefix = String(req.params.prefix || '').toLowerCase();
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || ''); if (!m) return res.status(401).json({ error: 'Connexion requise.' });
    const tok = await admin.auth().verifyIdToken(m[1]); const email = (tok.email || '').toLowerCase();
    const u = await fs.collection('authorizedUsers').doc(email).get();
    if (!u.exists || u.data().role !== 'editor') return res.status(403).json({ error: `Le compte ${email} n'a pas le rôle editor.` });
    res.json(await syncClient(prefix, email));
  } catch (e) { console.error(e); res.status(e.message && /déjà en cours/.test(e.message) ? 409 : 500).json({ error: e.message || String(e) }); }
});

const once = process.argv.includes('--once');
if (once) { (async () => { for (const c of CLIENTS) { try { console.log(JSON.stringify(await syncClient(c))); } catch (e) { console.error(c, e.message); process.exitCode = 1; } } process.exit(); })(); }
else {
  if (env('CRON', '')) cron.schedule(env('CRON'), async () => { for (const c of CLIENTS) { try { console.log('cron', JSON.stringify(await syncClient(c))); } catch (e) { console.error('cron', c, e.message); } } });
  app.listen(+env('PORT', 3000), () => console.log('smartshop-sync-woocommerce prêt, réseaux :', CLIENTS.join(', ')));
}
