/* Product sync for one site: Shopify -> dashboard DB -> (if changed) commit catalog to the site's GitHub repo -> trigger its build. */
const db = require("./db"), shopify = require("./shopify"), github = require("./github");
const crypto = require("crypto");

async function log(siteId, kind, status, note) { await db.run("INSERT INTO sync_log (site_id, kind, status, note) VALUES (?,?,?,?)", [siteId, kind, status, (note || "").slice(0, 2000)]); }

/* live progress of running syncs, by site id (shown as a bar on Sync & Deploy) */
const JOBS = new Map();
function job(siteId) { return JOBS.get(siteId) || null; }
function startJob(site, opts) {
  const cur = JOBS.get(site.id); if (cur && !cur.done) return cur;
  const j = { pct: 0, step: "Starting", detail: "", started: Date.now(), done: false, error: null, result: null, log: [] };
  JOBS.set(site.id, j);
  const progress = (pct, step, detail) => { j.pct = Math.max(j.pct, Math.min(100, Math.round(pct))); j.step = step; j.detail = detail || ""; j.log.push({ t: Date.now(), step, detail: j.detail }); if (j.log.length > 40) j.log.shift(); };
  (async () => {
    try {
      const r = await syncSafe(site, { ...opts, progress });
      if (r.error) { j.error = r.error; j.step = "Failed"; j.detail = r.error; }
      else {
        j.result = r; j.pct = 100; j.step = "Done"; j.detail = r.note;
        if (opts && opts.orders !== false) { try { progress(99, "Pulling orders", ""); await syncOrders(site); } catch (e) {} j.pct = 100; j.step = "Done"; }
      }
    } catch (e) { j.error = e.message; j.step = "Failed"; j.detail = e.message; }
    j.done = true; j.finished = Date.now();
    setTimeout(() => { if (JOBS.get(site.id) === j) JOBS.delete(site.id); }, 10 * 60 * 1000);
  })();
  return j;
}

/* A site repo can declare how it wants products in site-sync.json at its root:
     {"catalog": "raw", "query": "title:*NASCLA*", "rawPath": "data/shopify/raw-products.json"}
   "raw" means the repo turns Shopify data into its own catalog (its own build_catalog.py), so the dashboard
   commits the untouched product data and never writes shared/catalog.js itself. Without the file, the
   classic electrician-style catalog is written as before. */
async function repoSyncConfig(site, ghToken) {
  if (!site.github_repo || !ghToken) return null;
  try {
    const f = await github.getFile(ghToken, site.github_repo, "site-sync.json", site.github_branch || "main");
    if (!f || !f.content) return null;
    return JSON.parse(f.content);
  } catch (e) { if (/JSON/.test(e.message) || e instanceof SyntaxError) throw new Error("site-sync.json in the repo is not valid JSON"); return null; }
}

async function syncSite(site, opts = {}) {
  const prog = opts.progress || (() => {});
  const token = db.dec(site.shopify_token_enc), ghToken = db.dec(site.github_token_enc);
  if (!site.shopify_domain || !token) throw new Error("Shopify domain and token are required");
  prog(2, "Reading the site's sync settings", site.github_repo || "");
  const cfg = await repoSyncConfig(site, ghToken);
  if (cfg && cfg.catalog === "raw") return syncRaw(site, opts, cfg, token, ghToken);
  const ids = shopify.parseCollections(site.shopify_collection);
  if (!ids.length) throw new Error("Pick a collection in Settings (one numeric id, or several separated by commas)");
  prog(3, "Connecting to Shopify", site.shopify_domain);
  const { nodes, title } = await shopify.fetchCollections(site.shopify_domain, token, ids, (got, total, t) => prog(5 + (total ? Math.min(1, got / total) : 0.5) * 50, "Pulling products", total ? `${got} of ${total} in "${t}"` : `${got} so far`));
  if (nodes.length < 5 && !opts.force) throw new Error(`Only ${nodes.length} products returned; refusing to overwrite (use force to override)`);
  prog(57, "Comparing with the last pull", `${nodes.length} active products`);
  const { cat, full } = shopify.toCatalog(nodes);
  const fingerprint = crypto.createHash("sha1").update(JSON.stringify(cat) + JSON.stringify(full)).digest("hex");
  const prev = await db.get("SELECT note FROM sync_log WHERE site_id=? AND kind='fingerprint' ORDER BY id DESC LIMIT 1", [site.id]);
  const changed = !prev || prev.note !== fingerprint;

  // mirror products into the dashboard (always, so the Products page is current)
  let i = 0;
  for (const p of cat) {
    if (++i % 25 === 0) prog(60 + 22 * (i / cat.length), "Updating the Products page", `${i} of ${cat.length}`);
    await db.run(`INSERT INTO products (site_id, product_id, handle, title, state, level, year, tier, tier_name, price, compare_at, image, url, data, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(site_id, product_id) DO UPDATE SET handle=excluded.handle, title=excluded.title, state=excluded.state, level=excluded.level, year=excluded.year, tier=excluded.tier, tier_name=excluded.tier_name,
      price=excluded.price, compare_at=excluded.compare_at, image=excluded.image, url=excluded.url, data=excluded.data, updated_at=CURRENT_TIMESTAMP`,
      [site.id, p.id, p.handle, p.title, p.state, p.level, p.year, p.tier, p.tierName, Number(p.price), p.compareAt ? Number(p.compareAt) : null, p.image, p.url, JSON.stringify(p)]);
  }
  const liveIds = cat.map(p => p.id);
  const stale = await db.all("SELECT product_id FROM products WHERE site_id=?", [site.id]);
  for (const s of stale) if (!liveIds.includes(s.product_id)) await db.run("DELETE FROM products WHERE site_id=? AND product_id=?", [site.id, s.product_id]);

  let note = `${cat.length} products in "${title}"; ${changed ? "changed" : "no change"}`;
  let pushed = false;
  prog(84, changed ? "Changes found" : "No changes", changed ? "committing the new catalog to GitHub" : "nothing to push");
  if (changed && site.github_repo && ghToken && !opts.noPush) {
    const branch = site.github_branch || "main";
    prog(86, "Committing catalog.js", site.github_repo);
    const r1 = await github.putFile(ghToken, site.github_repo, "shared/catalog.js", branch, shopify.catalogJs(cat, site.name), `Catalog sync from dashboard: ${cat.length} products`);
    prog(91, "Committing products-full.json", site.github_repo);
    const r2 = await github.putFile(ghToken, site.github_repo, "store/products-full.json", branch, JSON.stringify(full), `Product descriptions sync from dashboard`);
    pushed = !(r1.unchanged && r2.unchanged);
    if (pushed) prog(96, "Triggering the site rebuild", "build.yml");
    if (pushed) { try { await github.dispatch(ghToken, site.github_repo, "build.yml", branch); note += "; committed to GitHub and build triggered"; } catch (e) { note += "; committed to GitHub (build.yml not found: the site rebuilds on next push)"; } }
    else note += "; GitHub already up to date";
  } else if (changed && !opts.noPush) note += "; no GitHub connection, site not updated";
  await log(site.id, "fingerprint", "ok", fingerprint);
  await log(site.id, "sync", "ok", note);
  await db.run("UPDATE sites SET last_sync_at=CURRENT_TIMESTAMP, last_sync_status='ok', last_sync_note=?, products_count=? WHERE id=?", [note, cat.length, site.id]);
  return { changed, pushed, count: cat.length, note };
}

/* raw mode: pull, mirror into the Products page, commit the raw data, trigger the site's build */
async function syncRaw(site, opts, cfg, token, ghToken) {
  const prog = opts.progress || (() => {});
  const branch = site.github_branch || "main";
  const ids = shopify.parseCollections(cfg.collections || (cfg.query ? "" : site.shopify_collection));
  if (!cfg.query && !ids.length) throw new Error("site-sync.json has no query, and no collection is set in Settings");
  prog(3, "Connecting to Shopify", site.shopify_domain);
  const { nodes, title } = await shopify.fetchRaw(site.shopify_domain, token, { query: cfg.query, collections: ids },
    (got, total, t) => prog(5 + (total ? Math.min(1, got / total) : 0.5) * 50, "Pulling products", total ? `${got} of ${total}: ${t}` : `${got} so far: ${t}`));
  const min = cfg.minProducts || 50;
  if (nodes.length < min && !opts.force) throw new Error(`Only ${nodes.length} products returned (this site expects at least ${min}); refusing to overwrite (use force to override)`);
  nodes.sort((a, b) => a.id < b.id ? -1 : 1);
  const fingerprint = crypto.createHash("sha1").update(JSON.stringify(nodes)).digest("hex");
  const prev = await db.get("SELECT note FROM sync_log WHERE site_id=? AND kind='fingerprint' ORDER BY id DESC LIMIT 1", [site.id]);
  const changed = !prev || prev.note !== fingerprint;

  // the Products page: state and title from the product, the Shopify product type as the package name
  const { cat } = shopify.toCatalog(nodes); let i = 0;
  for (const p of cat) {
    if (++i % 25 === 0) prog(60 + 22 * (i / cat.length), "Updating the Products page", `${i} of ${cat.length}`);
    const tierName = p.type || "Other";
    await db.run(`INSERT INTO products (site_id, product_id, handle, title, state, level, year, tier, tier_name, price, compare_at, image, url, data, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(site_id, product_id) DO UPDATE SET handle=excluded.handle, title=excluded.title, state=excluded.state, level=excluded.level, year=excluded.year, tier=excluded.tier, tier_name=excluded.tier_name,
      price=excluded.price, compare_at=excluded.compare_at, image=excluded.image, url=excluded.url, data=excluded.data, updated_at=CURRENT_TIMESTAMP`,
      [site.id, p.id, p.handle, p.title, p.state, p.level, p.year, tierName.toLowerCase().replace(/[^a-z0-9]+/g, "-"), tierName, Number(p.price), p.compareAt ? Number(p.compareAt) : null, p.image, p.url, JSON.stringify(p)]);
  }
  const keep = cat.map(p => p.id);
  for (const s of await db.all("SELECT product_id FROM products WHERE site_id=?", [site.id])) if (!keep.includes(s.product_id)) await db.run("DELETE FROM products WHERE site_id=? AND product_id=?", [site.id, s.product_id]);

  let note = `${nodes.length} products (${title}); ${changed ? "changed" : "no change"}`, pushed = false;
  prog(84, changed ? "Changes found" : "No changes", changed ? "committing the product data to GitHub" : "nothing to push");
  if (changed && site.github_repo && ghToken && !opts.noPush) {
    const path = cfg.rawPath || "data/shopify/raw-products.json";
    prog(88, "Committing product data", `${site.github_repo}/${path}`);
    const r = await github.putFile(ghToken, site.github_repo, path, branch, JSON.stringify(nodes), `Product sync from dashboard: ${nodes.length} products`);
    pushed = !r.unchanged;
    if (pushed) { prog(96, "Triggering the site rebuild", "build.yml"); try { await github.dispatch(ghToken, site.github_repo, cfg.workflow || "build.yml", branch); note += "; committed to GitHub and build triggered (the site turns it into its catalog)"; } catch (e) { note += "; committed to GitHub (the site rebuilds on the push)"; } }
    else note += "; GitHub already up to date";
  } else if (changed && !opts.noPush) note += "; no GitHub connection, site not updated";
  await log(site.id, "fingerprint", "ok", fingerprint);
  await log(site.id, "sync", "ok", note);
  await db.run("UPDATE sites SET last_sync_at=CURRENT_TIMESTAMP, last_sync_status='ok', last_sync_note=?, products_count=? WHERE id=?", [note, nodes.length, site.id]);
  return { changed, pushed, count: nodes.length, note };
}

async function syncSafe(site, opts) {
  try { return await syncSite(site, opts); }
  catch (e) { await log(site.id, "sync", "error", e.message); await db.run("UPDATE sites SET last_sync_at=CURRENT_TIMESTAMP, last_sync_status='error', last_sync_note=? WHERE id=?", [e.message.slice(0, 500), site.id]); return { error: e.message }; }
}

/* Which orders belong to a site. Shopify sells one store for every site, so an order counts for a site only when
   it carries the site's tag (attributes[Site] or ref=<domain>, added by the site's Buy now links) or when Shopify
   recorded a visit referred by the site's domain. Everything else came through the main store or another site. */
const hostOf = u => { try { return new URL(/^https?:/.test(u) ? u : "https://" + u).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; } };
function orderSource(o, host) {
  if (!host) return "";
  for (const a of o.customAttributes || []) if (/^_*site$/i.test(a.key) && hostOf(a.value) === host) return "site tag";
  const cj = o.customerJourneySummary || {};
  for (const v of [cj.firstVisit, cj.lastVisit]) {
    if (!v) continue;
    if (v.referralCode && hostOf(v.referralCode) === host) return "site tag";
    if (v.referrerUrl && hostOf(v.referrerUrl) === host) return "referred by site";
    if (v.landingPage && /[?&]ref=([^&]+)/.test(v.landingPage) && hostOf(decodeURIComponent(v.landingPage.match(/[?&]ref=([^&]+)/)[1])) === host) return "site tag";
  }
  return "";
}
async function syncOrders(site, days = 30) {
  const token = db.dec(site.shopify_token_enc); if (!site.shopify_domain || !token) return { skipped: true };
  const host = hostOf(site.url || "");
  if (!host) return { count: 0, matched: 0, note: "Add the site's live URL in Settings so its orders can be told apart from the rest of the store." };
  const orders = await shopify.recentOrders(site.shopify_domain, token, days);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const keep = [];
  for (const o of orders) {
    const src = orderSource(o, host); if (!src) continue;
    const id = o.id.split("/").pop(); keep.push(id);
    await db.run(`INSERT INTO orders (site_id, order_id, name, created_at, total, currency, status, items, source) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(site_id, order_id) DO UPDATE SET total=excluded.total, status=excluded.status, items=excluded.items, source=excluded.source`,
      [site.id, id, o.name, o.createdAt, Number(o.totalPriceSet.shopMoney.amount), o.totalPriceSet.shopMoney.currencyCode, o.displayFinancialStatus, JSON.stringify(o.lineItems.edges.map(e => ({ t: e.node.title, q: e.node.quantity, p: e.node.product ? e.node.product.id.split("/").pop() : null }))), src]);
  }
  // drop store orders saved before this filter existed, and anything in the window that no longer matches
  await db.run("DELETE FROM orders WHERE site_id=? AND (source IS NULL OR source='')", [site.id]);
  if (!orders.attributionMissing) {
    const stale = (await db.all("SELECT order_id FROM orders WHERE site_id=? AND created_at>=?", [site.id, since])).map(r => r.order_id).filter(id => !keep.includes(id));
    for (const id of stale) await db.run("DELETE FROM orders WHERE site_id=? AND order_id=?", [site.id, id]);
  }
  return { count: orders.length, matched: keep.length, note: orders.attributionMissing ? "Shopify did not return order sources: " + orders.attributionMissing : "" };
}

/* hourly scheduler: run each site's sync at its chosen weekday/hour (America/Chicago) */
function schedule() {
  const cron = require("node-cron");
  cron.schedule("7 * * * *", async () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: process.env.TZ_NAME || "America/Chicago" }));
    const sites = await db.all("SELECT * FROM sites WHERE sync_enabled=1 AND sync_weekday=? AND sync_hour=?", [now.getDay(), now.getHours()]);
    for (const s of sites) { console.log("scheduled sync:", s.slug); await syncSafe(s); try { await syncOrders(s); } catch (e) {} }
  });
}
module.exports = { syncSite, syncSafe, syncOrders, schedule, startJob, job };
