/* Smartshop – catalogue WooCommerce et regroupement par conseiller (sans dépendance Firebase, testable en local).

   Utilisé par server.js quand un réseau a :
     WC_<PREFIXE>_CATALOGUE=1       les produits de la boutique (publiés ET désactivés) deviennent le catalogue de l'outil ;
                                    les commandes prennent le nom actuel du produit (même produit = même ligne, même s'il a
                                    été renommé), et les produits en double (même nom) sont regroupés.
     WC_<PREFIXE>_FAMILIES          JSON {"début de catégorie": "Famille"}, ex. {"GOODIES":"Goodies","PRINT":"Print"} ;
                                    une famille vide ("NOUVEAUTES":"") fait ignorer cette catégorie (catégories thématiques)
     WC_<PREFIXE>_REGIONS           JSON {"code en fin de catégorie": "Région"}, ex. {"GO":"Grand-Ouest","HDF":"Hauts-de-France"}
     WC_<PREFIXE>_AGENCY=livraison  une agence = une personne, d'après le nom de LIVRAISON (prénom + nom) ;
     WC_<PREFIXE>_GENERIC           mots qui signalent un nom générique (ex. "FACILE,MASF") : ces commandes sont regroupées
                                    par ville de livraison, sous le libellé WC_<PREFIXE>_GENERIC_LABEL (ex. « Ma Santé Facile (Lille) »).
*/
const ENT = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', ndash: '–', mdash: '—', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ecirc: 'ê', ocirc: 'ô', deg: '°', euro: '€', hellip: '…', trade: '™', reg: '®', copy: '©' };
export const decode = s => String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
export const cleanName = s => decode(s).normalize('NFC').replace(/<\/?br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/[​\s]+/g, ' ').trim();
export const nz = s => decode(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, ' ').trim();
const normKey = s => nz(s).replace(/ /g, '');
const titleCase = s => String(s || '').toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const r2 = v => Math.round(num(v) * 100) / 100;
export function parseJson(s, label) { if (!s) return null; try { return JSON.parse(s); } catch (e) { throw new Error(`${label} : JSON invalide`); } }

/* famille et région d'un produit, d'après ses catégories WooCommerce */
export function categoryInfo(product, catById, cfg) {
  const fams = cfg.families || null, regs = cfg.regions || null;
  const famKeys = fams ? Object.keys(fams).map(k => [nz(k), fams[k]]).sort((a, b) => b[0].length - a[0].length) : [];
  const regKeys = regs ? new Map(Object.keys(regs).map(k => [nz(k), regs[k]])) : new Map();
  const famSet = new Map(), regSet = new Set();
  for (const c0 of (product.categories || [])) {
    const chain = []; let c = catById.get(c0.id) || { name: c0.name, parent: 0 }, guard = 0;
    while (c && guard++ < 10) { chain.unshift(decode(c.name)); c = c.parent ? catById.get(c.parent) : null; }
    const top = chain[0] || decode(c0.name);
    let fam = null;
    if (famKeys.length) { const t = nz(top); const hit = famKeys.find(([k]) => t === k || t.startsWith(k + ' ') || t.startsWith(k)); fam = hit ? hit[1] : null;
      if (hit && !hit[1]) continue; }  // catégorie thématique ignorée
    if (!fam) fam = titleCase(top);
    famSet.set(fam, (famSet.get(fam) || 0) + 1);
    for (const n of chain) { const toks = nz(n).split(' '); const last = toks[toks.length - 1]; if (toks.length > 1 && regKeys.has(last)) regSet.add(regKeys.get(last)); }
  }
  const fam = [...famSet].sort((a, b) => b[1] - a[1])[0];
  return { fam: fam ? fam[0] : 'Non renseignée', sub: regSet.size === 1 ? [...regSet][0] : regSet.size > 1 ? 'Toutes régions' : '' };
}

/* catalogue de l'outil : [nom, libellé, groupe, statut, [[quantité, prix HT]]], un élément par nom de produit */
export function buildCatalogue(products, categories, orders, cfg) {
  const catById = new Map((categories || []).map(c => [c.id, c]));
  const byId = new Map();
  for (const p of products) {
    const info = categoryInfo(p, catById, cfg);
    byId.set(p.id, { name: cleanName(p.name) || '(Produit sans nom)', fam: info.fam, sub: info.sub, status: p.status === 'publish' ? 'En ligne' : 'Désactivé', raw: p });
  }
  // prix observé : quantité la plus commandée et montant HT de la commande la plus récente à cette quantité
  const seen = new Map(), lines = new Map();
  for (const o of orders) for (const li of (o.line_items || [])) {
    const p = byId.get(li.product_id); if (!p) continue;
    const k = normKey(p.name); if (!lines.has(k)) lines.set(k, []); lines.get(k).push([o.date_created || '', Math.round(num(li.quantity)), r2(li.subtotal)]);
    seen.set(li.product_id, (seen.get(li.product_id) || 0) + 1);
  }
  const groups = new Map();
  for (const [id, p] of byId) { const k = normKey(p.name); if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ id, ...p, n: seen.get(id) || 0 }); }
  const items = [];
  for (const [k, g] of groups) {
    g.sort((a, b) => (b.status === 'En ligne') - (a.status === 'En ligne') || b.n - a.n);
    const main = [...g].sort((a, b) => b.n - a.n || (b.status === 'En ligne') - (a.status === 'En ligne'))[0];
    const ls = lines.get(k) || [], qc = new Map(); ls.forEach(l => qc.set(l[1], (qc.get(l[1]) || 0) + 1));
    let prices = [];
    if (ls.length) { const q = [...qc].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]; const last = ls.filter(l => l[1] === q).sort((a, b) => a[0] < b[0] ? 1 : -1)[0]; if (q > 0 && last[2] > 0) prices = [[q, last[2]]]; }
    items.push([main.name, main.name, main.fam, g.some(x => x.status === 'En ligne') ? 'En ligne' : 'Désactivé', prices]);
  }
  items.sort((a, b) => a[2].localeCompare(b[2], 'fr') || a[0].localeCompare(b[0], 'fr'));
  // nom et « Famille>Région » de chaque produit WooCommerce, pour les commandes
  const nameOf = new Map(), catOf = new Map();
  for (const [id, p] of byId) { nameOf.set(id, p.name); catOf.set(id, p.fam + (p.sub ? '>' + p.sub : '')); }
  return { items, nameOf, catOf };
}

/* commandes : nom actuel du produit (variation → produit parent), ou nom de la ligne nettoyé si le produit a été supprimé */
export function renameLines(orders, nameOf) {
  for (const o of orders) for (const li of (o.line_items || [])) {
    const cur = nameOf.get(li.product_id);
    const nm = cur || cleanName(li.parent_name || li.name);
    li.parent_name = nm; li.name = nm;
  }
  return orders;
}

/* regroupement par personne d'après le nom de livraison */
export function livraisonKey(o, cfg) {
  const ship = o.shipping || {}, bill = o.billing || {};
  let first = decode(ship.first_name).trim(), last = decode(ship.last_name).trim();
  if (!first && !last) { first = decode(bill.first_name).trim(); last = decode(bill.last_name).trim(); }
  const full = (first + ' ' + last).replace(/\s+/g, ' ').trim();
  const generic = (cfg.generic || []).map(nz).filter(Boolean), toks = nz(full).split(' ').filter(Boolean);
  const comp = nz(ship.company || '');
  if (!toks.length || toks.some(t => generic.includes(t)) || (comp && nz(full) === comp)) {
    const city = titleCase(decode(ship.city || bill.city || '').replace(/^\d{4,5}\s*-?\s*/, '').trim());
    const lab = cfg.genericLabel || titleCase(full) || 'Sans nom';
    return ['G|' + nz(city), lab + (city ? ' (' + city + ')' : '')];
  }
  return ['P|' + [...toks].sort().join(' '), (titleCase(first) + ' ' + last.toUpperCase()).replace(/\s+/g, ' ').trim()];
}
/* libellé retenu pour une clé : le plus fréquent, puis le plus récent */
export function pickLabels(keyed, dates) {
  const m = new Map();
  keyed.forEach(([k, l], i) => { if (!m.has(k)) m.set(k, new Map()); const x = m.get(k).get(l) || { n: 0, d: '' }; x.n++; if (dates[i] > x.d) x.d = dates[i]; m.get(k).set(l, x); });
  const best = new Map(); for (const [k, ls] of m) best.set(k, [...ls].sort((a, b) => b[1].n - a[1].n || (a[1].d < b[1].d ? 1 : -1))[0][0]);
  return keyed.map(([k]) => best.get(k));
}
