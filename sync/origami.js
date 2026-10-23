/* Smartshop – synchronisation des commandes Orpi depuis l'API Origami (marketplace Orpi).
   Applique exactement les règles de l'import des exports Origami dans l'outil (index.html, parseOrigami) :
   statuts retenus (origami.keep), rapprochement des agences par adresse de livraison (origami.agmap),
   noms de produits (origami.pidmap), catégories fusionnées (origami.catmap), commission réelle de la commande.
   La configuration « origami » vient des données de base de l'outil (collection orpi_base). */

const ogNz = s => String(s == null ? '' : s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const ogCp = v => { const d = String(v == null ? '' : v).replace(/\D/g, '').slice(0, 5); return d ? d.padStart(5, '0') : ''; };
const ogNum = v => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;
const titleCase = s => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const depOf = cp => !cp ? '' : cp.startsWith('97') ? cp.slice(0, 3) : cp.startsWith('98') ? 'MC' : cp.startsWith('20') ? (+cp < 20200 ? '2A' : '2B') : cp.slice(0, 2);
const rel = x => x == null ? null : (x.data !== undefined ? x.data : x);          // relation incluse : {data: …} ou objet direct
const list = x => { const v = rel(x); return Array.isArray(v) ? v : v ? [v] : []; };
const frName = obj => { const t = list(obj && obj.translations); const fr = t.find(x => x.locale === 'fr') || t[0]; return (fr && fr.name) || (obj && obj.name) || ''; };
// l'API renvoie l'heure de Paris suivie d'un « Z » : on garde la date et l'heure telles quelles, comme dans les exports
const apiDate = s => String(s || '').replace('T', ' ').slice(0, 16);

/* rapprochement d'une adresse de livraison avec une agence (même règle que l'outil) */
function makeAgency(og) {
  return (line1, cp, first, last) => {
    const L0 = (og.agmap[ogNz(line1)] || []).filter(t => !t[0] || t[0] === cp);
    const L = L0.some(t => t[2] !== '@annuaire') ? L0.filter(t => t[2] !== '@annuaire') : L0;
    const ex = ogNz(first + ' ' + last), pn = new Set([ex, ogNz(last + ' ' + first)]), raw = String(line1).trim();
    const tiers = [L.filter(t => t[1].includes(ex) && t[2] === raw), L.filter(t => t[1].includes(ex)), L.filter(t => t[1].some(n => pn.has(n))), L];
    const pick = tiers.find(t => t.length) || []; const labs = [...new Set(pick.map(t => t[3]))];
    if (pick.length && pick[0][2] === '@annuaire' && labs.length > 1) return null;
    return labs[0] || null;
  };
}

/* montant remboursé TTC d'une commande (relation « refunds ») */
function refundedTTC(o) {
  return list(o.refunds).reduce((s, r) => s + Math.abs(ogNum(r.amount_tax_inc ?? r.total_tax_inc ?? r.total_amount_tax_inc ?? r.amount ?? r.total ?? 0)), 0);
}

/* apiOrders : commandes de /v1/orders (include state, orderLines, shippingAddress, billingAddress, vouchers, refunds)
   products : Map product_id → {name, categoryId} ; categories : Map id → nom ; prevProducts : [[nom, gamme, sous-gamme], …] */
export function buildOrigamiDataset(apiOrders, { og, products = new Map(), categories = new Map(), prevProducts = [], knownAgencies = new Set() }) {
  if (!og || !og.agmap) throw new Error('Configuration Origami absente des données de base Orpi (champ « origami »).');
  const keep = new Set(og.keep || []), agency = makeAgency(og), catmap = og.catmap || {};
  const byPid = Object.assign({}, og.pidmap || {}), used = new Map(); Object.entries(byPid).forEach(([k, v]) => { if (!used.has(v)) used.set(v, k); });
  const prevFam = new Map((prevProducts || []).map(p => [p[0], [p[1], p[2] || '']]));
  const baseName = l => { const p = products.get(String(l.product_id)); return (p && p.name ? p.name.trim() : '') || String(l.name || '').split(/ - (?:Lot|Impression|Taille|Format|Couleur|Quantité)\s*:/)[0].trim() || '(Produit sans nom / supprimé)'; };
  const pname = (l, created) => {
    const key = String(l.product_id || '').trim() || ('L:' + baseName(l)); if (byPid[key]) return byPid[key];
    const base = baseName(l); let nm = base; if (used.has(nm) && used.get(nm) !== key) nm = base + ' (fiche ' + String(created || '').slice(0, 4) + ')';
    if (!used.has(nm)) used.set(nm, key); byPid[key] = nm; return nm;
  };
  const prodList = [], pidx = new Map(), pfam = new Map(), unknownAg = new Map(), out = [], skipped = { statut: 0, rembourse: 0 };
  const sorted = apiOrders.filter(o => (o.type || 'order') === 'order').sort((a, b) => apiDate(a.created_at).localeCompare(apiDate(b.created_at)));
  for (const o of sorted) {
    const st = rel(o.state); const stName = (st && (st.name || st.key)) || '';
    if (!keep.has(stName)) { skipped.statut++; continue; }
    const n = parseInt(o.id, 10); if (!n) continue;
    // remboursements : commande remboursée en totalité écartée ; remboursement partiel déduit au prorata
    const totInc = ogNum(o.total_tax_inc), refunded = refundedTTC(o);
    if (refunded > 0 && refunded >= totInc - 0.01) { skipped.rembourse++; continue; }
    const kr = refunded > 0 && totInc > 0 ? 1 - refunded / totInc : 1;
    const created = apiDate(o.created_at || o.date_order);
    const tp = ogNum(o.total_products_tax_exc), ls = list(o.orderLines || o.order_lines);
    const linesInc = ls.reduce((s, l) => s + ogNum(l.total_price_tax_inc), 0), ratio = linesInc ? tp / linesInc : 1 / 1.2;
    const items = new Map();
    for (const l of ls) {
      const nm = pname(l, created);
      if (!pidx.has(nm)) {
        pidx.set(nm, prodList.length); prodList.push(nm);
        const p = products.get(String(l.product_id)), c = String((p && categories.get(String(p.categoryId))) || '').trim();
        pfam.set(nm, prevFam.get(nm) || [(catmap[c] || c) || 'Non renseignée', '']);
      }
      const p = pidx.get(nm), q = Math.round(ogNum(l.quantity)), ht = ogNum(l.total_price_tax_inc) * ratio * kr;
      if (items.has(p)) { const it = items.get(p); it[0] += q; it[1] += ht; } else items.set(p, [q, ht]);
    }
    const ship = rel(o.shippingAddress) || {}, bill = rel(o.billingAddress) || {};
    const cp = ogCp(ship.postcode);
    let b = agency(ship.address_line1 || '', cp, bill.firstname || '', bill.lastname || '');
    if (!b) { b = ('NON IDENTIFIÉE – ' + String(ship.address_line1 || '').trim() + ', ' + String(ship.city || '').trim()).toUpperCase(); unknownAg.set(b, (unknownAg.get(b) || 0) + 1); }
    const codes = list(o.vouchers).map(v => String(v.code || '').trim()).filter(Boolean), disc = r2(ogNum(o.total_discounts_tax_exc) * kr);
    out.push([n, created, r2(tp * kr), r2(totInc - refunded), disc, codes.map((k, j) => [k.toLowerCase(), j ? 0 : disc]),
      [...items].map(([p, v]) => [p, v[0], r2(v[1])]), depOf(cp), cp, titleCase(String(ship.city || '').trim()), b,
      r2(ogNum(o.total_shipping_tax_exc) * kr), r2(ogNum(o.seller_fees_amount_tax_exc) * kr)]);
  }
  return {
    orders: out, products: prodList.map(nm => [nm, pfam.get(nm)[0], pfam.get(nm)[1]]), skipped,
    unknownAgencies: [...unknownAg.keys()].filter(k => !knownAgencies.has(k)),
    unknownProducts: prodList.filter(nm => !prevFam.has(nm)),
  };
}

/* lecture de toutes les commandes et des fiches produits / catégories utiles */
export async function fetchOrigami(get, ctx, { pidmap = {}, pageSize = 100 } = {}) {
  const orders = []; let page = 1, pages = 1;
  do {
    const r = await get('/v1/orders', { 'page[size]': String(pageSize), 'page[number]': String(page), 'order[name]': 'id', 'order[way]': 'asc', include: 'state,orderLines,shippingAddress,billingAddress,vouchers,refunds' }, ctx);
    orders.push(...(r.data || []));
    const pg = r.meta && r.meta.pagination; pages = pg ? pg.total_pages : page; page++;
  } while (page <= pages && page < 1000);
  // catégories (nom français) : seulement si un produit commandé n'est pas encore connu de l'outil
  const pids = new Set(); orders.forEach(o => list(o.orderLines || o.order_lines).forEach(l => { if (l.product_id != null) pids.add(String(l.product_id)); }));
  const missing = [...pids].filter(id => !pidmap[id]);
  const products = new Map(), categories = new Map();
  for (const id of missing) {
    try { const p = rel((await get('/v1/catalog/products/' + id, {}, ctx))) || {}; products.set(id, { name: frName(p), categoryId: p.default_category_id }); }
    catch (e) { products.set(id, { name: '', categoryId: null }); }
  }
  if (missing.length) {
    let cp = 1, cps = 1;
    do {
      const r = await get('/v1/catalog/categories', { 'page[size]': '200', 'page[number]': String(cp) }, ctx);
      (r.data || []).forEach(c => categories.set(String(c.id), frName(c)));
      const pg = r.meta && r.meta.pagination; cps = pg ? pg.total_pages : cp; cp++;
    } while (cp <= cps && cp < 100);
  }
  return { orders, products, categories, missingProducts: missing.length };
}
