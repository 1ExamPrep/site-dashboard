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

async function syncSite(site, opts = {}) {
  const prog = opts.progress || (() => {});
  const token = db.dec(site.shopify_token_enc), ghToken = db.dec(site.github_token_enc);
  if (!site.shopify_domain || !token || !site.shopify_collection) throw new Error("Shopify domain, token and collection are required");
  prog(3, "Connecting to Shopify", site.shopify_domain);
  const { nodes, title } = await shopify.fetchCollection(site.shopify_domain, token, site.shopify_collection, (got, total, t) => prog(5 + (total ? Math.min(1, got / total) : 0.5) * 50, "Pulling products", total ? `${got} of ${total} in "${t}"` : `${got} so far`));
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
  const ids = cat.map(p => p.id);
  const stale = await db.all("SELECT product_id FROM products WHERE site_id=?", [site.id]);
  for (const s of stale) if (!ids.includes(s.product_id)) await db.run("DELETE FROM products WHERE site_id=? AND product_id=?", [site.id, s.product_id]);

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

async function syncSafe(site, opts) {
  try { return await syncSite(site, opts); }
  catch (e) { await log(site.id, "sync", "error", e.message); await db.run("UPDATE sites SET last_sync_at=CURRENT_TIMESTAMP, last_sync_status='error', last_sync_note=? WHERE id=?", [e.message.slice(0, 500), site.id]); return { error: e.message }; }
}

async function syncOrders(site, days = 30) {
  const token = db.dec(site.shopify_token_enc); if (!site.shopify_domain || !token) return { skipped: true };
  const orders = await shopify.recentOrders(site.shopify_domain, token, days);
  for (const o of orders) {
    await db.run(`INSERT INTO orders (site_id, order_id, name, created_at, total, currency, status, items) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(site_id, order_id) DO UPDATE SET total=excluded.total, status=excluded.status, items=excluded.items`,
      [site.id, o.id.split("/").pop(), o.name, o.createdAt, Number(o.totalPriceSet.shopMoney.amount), o.totalPriceSet.shopMoney.currencyCode, o.displayFinancialStatus, JSON.stringify(o.lineItems.edges.map(e => ({ t: e.node.title, q: e.node.quantity, p: e.node.product ? e.node.product.id.split("/").pop() : null })))]);
  }
  return { count: orders.length };
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
