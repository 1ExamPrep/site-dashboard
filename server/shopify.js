/* Shopify Admin GraphQL: pull a collection into catalog items (same shape and rules as tools/build_catalog.py in the site template). */
const STATES = ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"];
const SLUG = { ultimate: "ultimate-combo", super: "super-combo", calc: "study-guide-calculations-nec", "nec-tabs": "study-guide-nec-tabs", nec: "study-guide-nec", "book-fc": "study-guide-flash-cards", online: "online-test-success-kit", flash: "flash-cards", calcbook: "calculations-study-guide", book: "study-guide", other: "other" };
const API = process.env.SHOPIFY_API_VERSION || "2025-07";

const QUERY = `query($id: ID!, $first: Int!, $after: String) { collection(id: $id) { title products(first: $first, after: $after) {
  edges { node { id title handle status productType vendor tags onlineStoreUrl description(truncateAt: 700) descriptionHtml
    featuredImage { url altText } images(first: 6) { edges { node { url altText } } }
    priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
    variants(first: 5) { edges { node { id title price compareAtPrice availableForSale } } } } }
  pageInfo { hasNextPage endCursor } } } }`;

/* Credentials: either an Admin API access token (shpat_…, from a custom app made in the store admin) or
   "clientId:clientSecret" from a Dev Dashboard app that is installed on the store. For the second kind we
   fetch a 24-hour access token with the client-credentials grant and cache it. */
const TOK = new Map();
async function resolveToken(domain, cred) {
  cred = String(cred || "").trim();
  const m = cred.match(/^([0-9a-f]{20,}):(shpss_[0-9a-f]+)$/i) || cred.match(/^([0-9a-f]{20,})[\s,;]+(shpss_[0-9a-f]+)$/i);
  if (!m) { if (/^shpss_/.test(cred)) throw new Error("that is a client secret; paste it together with the client id as  clientId:clientSecret, or use an Admin API access token (shpat_…)"); return cred; }
  const key = domain + "|" + m[1]; const c = TOK.get(key); if (c && c.exp > Date.now()) return c.token;
  const base = domain.startsWith("http") ? domain : "https://" + domain;
  const r = await fetch(`${base}/admin/oauth/access_token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grant_type: "client_credentials", client_id: m[1], client_secret: m[2] }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(`Shopify token exchange ${r.status}: ${JSON.stringify(d).slice(0, 200)} (is the app installed on this store with read_products/read_orders scopes?)`);
  TOK.set(key, { token: d.access_token, exp: Date.now() + Math.max(60, (d.expires_in || 86400) - 300) * 1000 });
  return d.access_token;
}
async function gql(domain, cred, query, variables) {
  const base = domain.startsWith("http") ? domain : "https://" + domain;
  const token = await resolveToken(domain, cred);
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(`${base}/admin/api/${API}/graphql.json`, { method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token }, body: JSON.stringify({ query, variables }) });
    if (r.status === 429 && attempt < 4) { await new Promise(res => setTimeout(res, 2000 + attempt * 2000)); continue; }
    if (!r.ok) throw new Error(`Shopify ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json(); if (d.errors) throw new Error("Shopify: " + JSON.stringify(d.errors).slice(0, 300));
    return d.data;
  }
}
async function shopInfo(domain, token) {
  const d = await gql(domain, token, `{ shop { name myshopifyDomain primaryDomain { url } currencyCode } }`, {});
  return d.shop;
}
async function fetchCollection(domain, token, collectionId, onPage) {
  const nodes = []; let after = null, title = "", total = 0;
  try { const c0 = await gql(domain, token, `query($id: ID!) { collection(id: $id) { title productsCount { count } } }`, { id: "gid://shopify/Collection/" + collectionId }); if (c0.collection) { total = c0.collection.productsCount.count; title = c0.collection.title; } } catch (e) {}
  if (onPage) onPage(0, total, title);
  while (true) {
    const d = await gql(domain, token, QUERY, { id: "gid://shopify/Collection/" + collectionId, first: 50, after });
    if (!d.collection) throw new Error("Collection not found: " + collectionId);
    title = d.collection.title; const c = d.collection.products;
    nodes.push(...c.edges.map(e => e.node));
    if (onPage) onPage(nodes.length, total, title);
    if (!c.pageInfo.hasNextPage) break; after = c.pageInfo.endCursor;
  }
  return { title, nodes: nodes.filter(n => n.status === "ACTIVE") };
}
/* one blog article (needs the read_content scope) */
async function getArticle(domain, cred, articleId) {
  const d = await gql(domain, cred, `query($id: ID!) { article(id: $id) { id title handle body summary tags publishedAt isPublished author { name } image { url altText } blog { handle title } } }`, { id: "gid://shopify/Article/" + articleId });
  return d.article;
}
/* recent published articles across the store's blogs (for mirroring without a webhook) */
async function listArticles(domain, cred, limit = 50) {
  const d = await gql(domain, cred, `query($n: Int!) { articles(first: $n, sortKey: PUBLISHED_AT, reverse: true, query: "published_status:published") { edges { node { id title handle body summary tags publishedAt isPublished author { name } image { url } blog { handle title } } } } }`, { n: limit });
  return d.articles.edges.map(e => e.node);
}
async function listCollections(domain, token) {
  const d = await gql(domain, token, `{ collections(first: 100, sortKey: TITLE) { edges { node { id title productsCount { count } } } } }`, {});
  return d.collections.edges.map(e => ({ id: e.node.id.split("/").pop(), title: e.node.title, count: e.node.productsCount.count }));
}
async function recentOrders(domain, token, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const out = []; let after = null;
  for (let i = 0; i < 10; i++) {
    const d = await gql(domain, token, `query($q: String!, $after: String) { orders(first: 50, after: $after, query: $q, sortKey: CREATED_AT, reverse: true) {
      edges { node { id name createdAt displayFinancialStatus totalPriceSet { shopMoney { amount currencyCode } } lineItems(first: 10) { edges { node { title quantity product { id } } } } } }
      pageInfo { hasNextPage endCursor } } }`, { q: `created_at:>=${since}`, after });
    out.push(...d.orders.edges.map(e => e.node));
    if (!d.orders.pageInfo.hasNextPage) break; after = d.orders.pageInfo.endCursor;
  }
  return out;
}

function tier(t) {
  t = t.toLowerCase();
  if (t.includes("ultimate combo")) return ["ultimate", "Ultimate Combo", 5];
  if (t.includes("super combo")) return ["super", "Super Combo", 4];
  if (t.includes("calculations study guides & national electrical code combo")) return ["calc", "Study Guide + Calculations + NEC", 3];
  if (t.includes("national electrical code combo with tabs")) return ["nec-tabs", "Study Guide + NEC with Tabs", 2];
  if (t.includes("national electrical code combo")) return ["nec", "Study Guide + NEC", 2];
  if (t.includes("flash card combo")) return ["book-fc", "Study Guide + Flash Cards", 1];
  if (t.includes("online test success kit")) return ["online", "Online Test Success Kit", 0];
  if (t.includes("flash cards")) return ["flash", "Flash Cards", 0];
  if (t.includes("practical calculations")) return ["calcbook", "Calculations Study Guide", 0];
  if (t.includes("exam prep and study guide")) return ["book", "Study Guide", 0];
  return ["other", "Other", 0];
}
function cleanHtml(h, title) {
  h = h || "";
  h = h.replace(/<(script|style|iframe|video|table)[\s\S]*?<\/\1>/gi, "").replace(/<img[^>]*>/gi, "");
  h = h.replace(/<\/?(span|div|section|font|u)\b[^>]*>/gi, "");
  h = h.replace(/<(\/?)h2\b[^>]*>/gi, "<$1h3>").replace(/<(\/?)b\b[^>]*>/gi, "<$1strong>").replace(/<(\/?)i\b[^>]*>/gi, "<$1em>");
  h = h.replace(/<a\b[^>]*href="(https?:[^"]*)"[^>]*>/gi, '<a href="$1" rel="noopener" target="_blank">').replace(/<a\b(?![^>]*href="http)[^>]*>/gi, "").replace(/<\/a>/gi, m => m);
  h = h.replace(/<(p|h3|h4|strong|em|ul|ol|li|br)\b[^>]*>/gi, (m, t) => `<${t.toLowerCase()}>`);
  h = h.replace(/<(?!\/?(p|h3|h4|strong|em|ul|ol|li|br|a)\b)[^>]+>/gi, "");
  h = h.replace(/<(p|h3|li)>\s*<\/\1>/g, "").replace(/\s+\n/g, "\n").trim();
  const norm = x => x.toLowerCase().replace(/&amp;/g, "&").replace(/[^a-z0-9]/g, "");
  const m = h.match(/^\s*<h3>([\s\S]*?)<\/h3>/);
  if (m && (norm(m[1]) === norm(title) || norm(m[1]) === norm(title.replace("Calculations", "C1alculations")))) h = h.slice(m[0].length).trim();
  return h;
}
function toCatalog(nodes) {
  const cat = [], full = {};
  for (const n of nodes) {
    const t = n.title; let st = null;
    for (const s of [...STATES].sort((a, b) => b.length - a.length)) if (new RegExp("\\b" + s + "\\b").test(t)) { st = s; break; }
    const level = t.includes("Journeyman") ? "Journeyman" : (t.includes("Master") ? "Master" : "General");
    const [tk, tn, rank] = tier(t);
    const ym = t.match(/^(20\d\d)\b/); const year = ym ? ym[1] : ((n.tags || []).find(x => /^20\d\d$/.test(x)) || "2026");
    const vs = n.variants.edges.map(v => ({ id: v.node.id.split("/").pop(), title: v.node.title, price: v.node.price, compareAt: v.node.compareAtPrice, available: v.node.availableForSale !== false }));
    const pid = n.id.split("/").pop();
    let desc = n.description || ""; if (desc.length > 700) desc = desc.slice(0, 697) + "...";
    cat.push({ id: pid, handle: n.handle, title: t.replace("C1alculations", "Calculations"), state: st, level, year, tier: tk, tierSlug: SLUG[tk], tierName: tn, rank, type: n.productType || "",
      price: n.priceRangeV2.minVariantPrice.amount, maxPrice: n.priceRangeV2.maxVariantPrice.amount, compareAt: vs[0] ? vs[0].compareAt : null,
      image: (n.featuredImage || {}).url || "", url: n.onlineStoreUrl || "", desc, variants: vs });
    const imgs = ((n.images || {}).edges || []).map(i => i.node.url); full[pid] = { html: cleanHtml(n.descriptionHtml, t), images: imgs.length ? imgs : [(n.featuredImage || {}).url || ""] };
  }
  return { cat, full };
}
function catalogJs(cat, note) {
  return `/* Auto-generated from Shopify by the site dashboard${note ? " (" + note + ")" : ""}, pulled ${new Date().toISOString().slice(0, 10)}. ${cat.length} products. Regenerate rather than hand-edit. */\nwindow.CATALOG=${JSON.stringify(cat)};\nwindow.CATALOG_STATES=${JSON.stringify(STATES)};\n`;
}
module.exports = { resolveToken, getArticle, listArticles, shopInfo, fetchCollection, listCollections, recentOrders, toCatalog, catalogJs, STATES };
