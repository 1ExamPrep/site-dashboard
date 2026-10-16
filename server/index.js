/* Site Dashboard: one admin for many static sites (tracking, products, Shopify sync, GitHub deploys). */
const express = require("express"), cookieParser = require("cookie-parser"), crypto = require("crypto"), path = require("path");
const db = require("./db"), V = require("./views"), shopify = require("./shopify"), github = require("./github"), sync = require("./sync"), blog = require("./blog");

const APP_SECRET = process.env.APP_SECRET || "dev-secret-change-me";
const TZ = process.env.TZ_NAME || "America/Chicago";
const app = express();
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.json({ limit: "2mb", type: ["application/json", "text/plain"] }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "1h" }));

/* ---------- auth ---------- */
const sign = v => v + "." + crypto.createHmac("sha256", APP_SECRET).update(v).digest("base64url");
const unsign = s => { if (!s) return null; const i = s.lastIndexOf("."); if (i < 0) return null; const v = s.slice(0, i); return sign(v) === s ? v : null; };
const hashPw = (pw, salt) => { salt = salt || crypto.randomBytes(16).toString("hex"); return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex"); };
const checkPw = (pw, stored) => { const [salt, h] = String(stored).split(":"); return !!h && crypto.timingSafeEqual(Buffer.from(hashPw(pw, salt).split(":")[1], "hex"), Buffer.from(h, "hex")); };
async function user(req) { const v = unsign(req.cookies.sess); if (!v) return null; const [uid, exp] = v.split(":"); if (Date.now() > +exp) return null; return db.get("SELECT id, email, role FROM users WHERE id=?", [uid]); }
const auth = async (req, res, next) => { req.user = await user(req); if (!req.user) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl)); req.sites = await db.all("SELECT * FROM sites ORDER BY name"); req.ctx = { req, user: req.user, sites: req.sites, baseUrl: baseUrl(req) }; next(); };
const baseUrl = req => (process.env.BASE_URL || (req.protocol + "://" + req.get("host"))).replace(/\/$/, "");
app.get("/login", (req, res) => res.send(V.loginPage()));
app.post("/login", async (req, res) => {
  const u = await db.get("SELECT * FROM users WHERE email=?", [String(req.body.email || "").toLowerCase().trim()]);
  if (!u || !checkPw(String(req.body.password || ""), u.pass_hash)) return res.status(401).send(V.loginPage("Wrong email or password."));
  res.cookie("sess", sign(u.id + ":" + (Date.now() + 14 * 86400000)), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: 14 * 86400000 });
  res.redirect(req.query.next && req.query.next.startsWith("/") ? req.query.next : "/");
});
app.get("/logout", (req, res) => { res.clearCookie("sess"); res.redirect("/login"); });

/* ---------- tracker (public, CORS) ---------- */
app.get("/t.js", (req, res) => { res.type("application/javascript").set("Cache-Control", "public, max-age=3600").sendFile(path.join(__dirname, "..", "public", "t.js")); });
app.options("/t", (req, res) => res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST" }).sendStatus(204));
const dayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const hourStr = () => new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour12: false, hour: "2-digit" }).slice(0, 2);
app.post("/t", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const site = await db.get("SELECT id FROM sites WHERE site_key=?", [String(b.k || "")]); if (!site) return res.status(204).end();
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim(), ua = req.headers["user-agent"] || "";
    const visitor = crypto.createHash("sha1").update(ip + "|" + ua + "|" + dayStr() + "|" + APP_SECRET).digest("hex").slice(0, 16);
    const device = /ipad|tablet/i.test(ua) ? "tablet" : /mobi|android|iphone/i.test(ua) ? "mobile" : "desktop";
    const evs = Array.isArray(b.e) ? b.e.slice(0, 20) : [b];
    for (const e of evs) {
      const name = String(e.n || e.event || "").slice(0, 40); if (!name) continue;
      const p = e.p || {};
      let ref = String(e.r || "").slice(0, 200); try { if (ref) ref = new URL(ref).hostname.replace(/^www\./, ""); } catch (x) {}
      await db.run(`INSERT INTO events (site_id, day, event, path, session_id, visitor, product_id, variant_id, price, state, level, tier, location, referrer, device, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [site.id, dayStr(), name, String(e.u || "").slice(0, 300), String(e.s || "").slice(0, 40), visitor, String(p.product_id || "").slice(0, 40), String(p.variant_id || "").slice(0, 40), Number(p.price || p.value || 0) || 0,
         String(p.state || "").slice(0, 40), String(p.level || "").slice(0, 20), String(p.tier || "").slice(0, 60), String(p.button_location || p.location || "").slice(0, 40), ref, device,
         JSON.stringify({ q: p.search_term, question: p.question, title: p.title, hour: hourStr() }).slice(0, 500)]);
    }
  } catch (e) { /* never break the visitor's page */ }
  res.status(204).end();
});

/* ---------- stats ---------- */
async function stats(siteId, days) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
  const W = "site_id=? AND day>=?", P = [siteId, since];
  const daily = await db.all(`SELECT day, COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT visitor) AS visitors, SUM(CASE WHEN event='page_view' THEN 1 ELSE 0 END) AS views, SUM(CASE WHEN event='buy_now_click' THEN 1 ELSE 0 END) AS buys FROM events WHERE ${W} GROUP BY day ORDER BY day`, P);
  // fill missing days
  const map = Object.fromEntries(daily.map(r => [r.day, r])); const out = [];
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toLocaleDateString("en-CA", { timeZone: TZ }); out.push(map[d] || { day: d, sessions: 0, visitors: 0, views: 0, buys: 0 }); }
  const tot = (await db.get(`SELECT COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT visitor) AS visitors, SUM(CASE WHEN event='page_view' THEN 1 ELSE 0 END) AS views, SUM(CASE WHEN event='buy_now_click' THEN 1 ELSE 0 END) AS buys,
    SUM(CASE WHEN event='buy_now_click' THEN price ELSE 0 END) AS value, SUM(CASE WHEN event='phone_click' THEN 1 ELSE 0 END) AS phone, SUM(CASE WHEN event='search' THEN 1 ELSE 0 END) AS searches,
    SUM(CASE WHEN event='select_item' THEN 1 ELSE 0 END) AS details, SUM(CASE WHEN event='select_variant' THEN 1 ELSE 0 END) AS variants FROM events WHERE ${W}`, P)) || {};
  const top = (col, ev, lim = 12, filt = "") => db.all(`SELECT ${col} AS k, COUNT(*) AS v FROM events WHERE ${W} AND event=? ${filt} GROUP BY ${col} ORDER BY v DESC LIMIT ${lim}`, [...P, ev]);
  const byState = await top("state", "buy_now_click", 12, "AND state<>''"), byTier = await top("tier", "buy_now_click", 10, "AND tier<>''"), byLevel = await top("level", "buy_now_click", 5, "AND level<>''"), byLocation = await top("location", "buy_now_click", 10, "AND location<>''");
  const byProductRaw = await top("product_id", "buy_now_click", 15, "AND product_id<>''");
  const prodNames = Object.fromEntries((await db.all("SELECT product_id, state, level, tier_name FROM products WHERE site_id=?", [siteId])).map(p => [p.product_id, `${p.state || "General"} ${p.level} ${p.tier_name}`]));
  const byProduct = byProductRaw.map(r => ({ k: prodNames[r.k] || r.k, v: r.v }));
  const pages = await top("path", "page_view", 12), referrers = (await top("referrer", "page_view", 10)).map(r => ({ k: r.k || "direct / typed", v: r.v })), devices = await top("device", "page_view", 4);
  const events = await db.all(`SELECT event AS k, COUNT(*) AS v FROM events WHERE ${W} GROUP BY event ORDER BY v DESC LIMIT 20`, P);
  const extraTop = async (key, ev, lim = 12) => (await db.all(`SELECT extra AS k, COUNT(*) AS v FROM events WHERE ${W} AND event=? GROUP BY extra ORDER BY v DESC LIMIT 60`, [...P, ev])).map(r => { let x = {}; try { x = JSON.parse(r.k); } catch (e) {} return { k: x[key] || "", v: r.v }; }).filter(r => r.k).reduce((a, r) => { const f = a.find(x => x.k === r.k); if (f) f.v += r.v; else a.push(r); return a; }, []).sort((a, b) => b.v - a.v).slice(0, lim);
  const searches = await extraTop("q", "search"), faq = await extraTop("question", "faq_open", 10);
  const hoursRaw = await db.all(`SELECT extra AS k, session_id FROM events WHERE ${W} AND event='page_view'`, P);
  const hourMap = {}; const seen = new Set(); hoursRaw.forEach(r => { let h = ""; try { h = JSON.parse(r.k).hour; } catch (e) {} if (!h) return; const key = h + r.session_id; if (seen.has(key)) return; seen.add(key); hourMap[h] = (hourMap[h] || 0) + 1; });
  const hours = Object.keys(hourMap).sort().map(h => ({ k: h + ":00", v: hourMap[h] }));
  const statesViewed = (await db.all(`SELECT path AS k, COUNT(*) AS v FROM events WHERE ${W} AND event='page_view' GROUP BY path`, P)).reduce((a, r) => { const m = r.k.match(/\/([a-z-]+)\/(journeyman|master)\//); if (!m) return a; const k = m[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase()); const f = a.find(x => x.k === k); if (f) f.v += r.v; else a.push({ k, v: r.v }); return a; }, []).sort((a, b) => b.v - a.v).slice(0, 12);
  const recent = (await db.all(`SELECT e.ts, e.product_id, e.variant_id, e.price, e.location, e.path, p.state, p.level, p.tier_name FROM events e LEFT JOIN products p ON p.site_id=e.site_id AND p.product_id=e.product_id WHERE e.site_id=? AND e.event='buy_now_click' ORDER BY e.id DESC LIMIT 25`, [siteId])).map(r => ({ ...r, ts: String(r.ts).slice(0, 16).replace("T", " "), title: r.tier_name ? `${r.state || "General"} ${r.level} ${r.tier_name}` : "" }));
  const orders = (await db.get(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM orders WHERE site_id=? AND created_at>=?`, [siteId, since])) || { count: 0, total: 0 };
  return { daily: out, tot, byState, byTier, byLevel, byLocation, byProduct, pages, referrers, devices, events, searches, faq, hours, statesViewed, recent, orders };
}

/* ---------- pages ---------- */
app.get("/", auth, async (req, res) => {
  const st = {}; const since = new Date(Date.now() - 6 * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
  for (const r of await db.all(`SELECT site_id, COUNT(DISTINCT session_id) AS sessions, SUM(CASE WHEN event='page_view' THEN 1 ELSE 0 END) AS views, SUM(CASE WHEN event='buy_now_click' THEN 1 ELSE 0 END) AS buys FROM events WHERE day>=? GROUP BY site_id`, [since])) st[r.site_id] = r;
  res.send(V.homePage(req.ctx, req.sites, st));
});
app.get("/sites/new", auth, (req, res) => res.send(V.newSitePage(req.ctx)));
app.post("/sites/new", auth, async (req, res) => {
  const b = req.body, name = String(b.name || "").trim(); if (!name) return res.send(V.newSitePage(req.ctx, "Name is required", b));
  try { shopifyCred(b); } catch (e) { return res.send(V.newSitePage(req.ctx, e.message, b)); }
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site"; let i = 1, base = slug; while (await db.get("SELECT id FROM sites WHERE slug=?", [slug])) slug = base + "-" + (++i);
  const key = "sk_" + crypto.randomBytes(12).toString("hex");
  const shopCred = shopifyCred(b);
  await db.run(`INSERT INTO sites (slug, name, url, site_key, webhook_secret, github_repo, github_token_enc, shopify_domain, shopify_token_enc, shopify_collection, shopify_store_url) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [slug, name, String(b.url || "").trim(), key, blog.newSecret(), String(b.github_repo || "").trim(), db.enc(String(b.github_token || "").trim()), String(b.shopify_domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""), db.enc(shopCred), String(b.shopify_collection || "").trim(), String(b.shopify_store_url || "").trim()]);
  res.redirect(`/sites/${slug}/settings?ok=` + encodeURIComponent("Site connected. Your tracker key is ready below; add Shopify and GitHub details if you skipped them."));
});
/* Shopify credential from a form: a shpat_ token, or clientId:clientSecret from a Dev Dashboard app */
function shopifyCred(b) {
  const t = String(b.shopify_token || "").trim(), id = String(b.shopify_client_id || "").trim(), sec = String(b.shopify_client_secret || "").trim();
  if (id && sec) return id + ":" + sec;
  if (/^shpss_/.test(t)) throw Object.assign(new Error("That is a client secret, not an access token. Paste the Client ID in its own box next to it, or use a shpat_ token."), { user: true });
  return t;
}
const site = async (req, res, next) => { req.site = await db.get("SELECT * FROM sites WHERE slug=?", [req.params.slug]); if (!req.site) return res.status(404).send("No such site"); req.days = [7, 28, 90].includes(+req.query.days) ? +req.query.days : 28; next(); };
app.get("/sites/:slug", auth, site, async (req, res) => res.send(V.sitePage(req.ctx, req.site, req.days, await stats(req.site.id, req.days))));
app.get("/sites/:slug/analytics", auth, site, async (req, res) => res.send(V.analyticsPage(req.ctx, req.site, req.days, await stats(req.site.id, req.days))));
app.get("/sites/:slug/clicks", auth, site, async (req, res) => res.send(V.clicksPage(req.ctx, req.site, req.days, await stats(req.site.id, req.days))));
app.get("/sites/:slug/products", auth, site, async (req, res) => {
  const q = String(req.query.q || "").toLowerCase().trim(); const since = new Date(Date.now() - 27 * 86400000).toLocaleDateString("en-CA", { timeZone: TZ });
  const buys = Object.fromEntries((await db.all("SELECT product_id AS k, COUNT(*) AS v FROM events WHERE site_id=? AND event='buy_now_click' AND day>=? GROUP BY product_id", [req.site.id, since])).map(r => [r.k, r.v]));
  let rows = await db.all("SELECT * FROM products WHERE site_id=? ORDER BY state, level, tier, price", [req.site.id]);
  const slugS = s => (s || "general").toLowerCase().replace(/ /g, "-");
  rows = rows.map(p => { let d = {}; try { d = JSON.parse(p.data); } catch (e) {} return { ...p, buys: buys[p.product_id] || 0, page: d.rank > 0 && req.site.url ? `${req.site.url.replace(/\/$/, "")}/${slugS(p.state)}/${p.level.toLowerCase()}/${p.year}/${d.tierSlug}/` : "" }; });
  if (q) rows = rows.filter(p => `${p.state || "general"} ${p.level} ${p.tier_name} ${p.price} ${p.title}`.toLowerCase().includes(q));
  const all = await db.all("SELECT state, level, year, tier, price FROM products WHERE site_id=?", [req.site.id]); const seen = new Set(); let dupes = 0;
  all.forEach(p => { const k = `${p.state}|${p.level}|${p.year}|${p.tier}`; if (seen.has(k)) dupes++; else seen.add(k); });
  res.send(V.productsPage(req.ctx, req.site, rows, q, { count: all.length, lo: Math.min(...all.map(p => p.price)), hi: Math.max(...all.map(p => p.price)), dupes, buys: Object.values(buys).reduce((a, b) => a + b, 0) }));
});
app.get("/sites/:slug/products.csv", auth, site, async (req, res) => {
  const rows = await db.all("SELECT product_id, state, level, year, tier_name, title, price, compare_at, url FROM products WHERE site_id=? ORDER BY state, level, tier", [req.site.id]);
  const csv = ["product_id,state,level,year,package,title,price,compare_at,url", ...rows.map(r => [r.product_id, r.state || "General", r.level, r.year, r.tier_name, r.title, r.price, r.compare_at || "", r.url].map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
  res.type("text/csv").attachment(`${req.site.slug}-products.csv`).send(csv);
});
app.get("/sites/:slug/orders", auth, site, async (req, res) => {
  const since = new Date(Date.now() - (req.days - 1) * 86400000).toISOString().slice(0, 10);
  const rows = await db.all("SELECT * FROM orders WHERE site_id=? AND created_at>=? ORDER BY created_at DESC", [req.site.id, since]);
  const dailyM = {}; const items = {}; rows.forEach(o => { const d = String(o.created_at).slice(0, 10); dailyM[d] = (dailyM[d] || 0) + o.total; JSON.parse(o.items || "[]").forEach(i => { items[i.t] = (items[i.t] || 0) + i.q; }); });
  const daily = []; for (let i = req.days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); daily.push({ day: d, total: dailyM[d] || 0 }); }
  const buys = (await db.get("SELECT COUNT(*) AS c FROM events WHERE site_id=? AND event='buy_now_click' AND day>=?", [req.site.id, since]) || {}).c || 0;
  res.send(V.ordersPage(req.ctx, req.site, req.days, { count: rows.length, total: rows.reduce((a, o) => a + o.total, 0), daily, items: Object.entries(items).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 10), recent: rows.slice(0, 30), buys }));
});
app.post("/sites/:slug/orders/refresh", auth, site, async (req, res) => { try { const r = await sync.syncOrders(req.site, 90); res.redirect(`/sites/${req.site.slug}/orders?ok=` + encodeURIComponent(r.skipped ? "Connect Shopify first" : `Pulled ${r.count} orders from the last 90 days`)); } catch (e) { res.redirect(`/sites/${req.site.slug}/orders?err=` + encodeURIComponent(e.message)); } });
app.get("/sites/:slug/sync", auth, site, async (req, res) => {
  const logs = await db.all("SELECT * FROM sync_log WHERE site_id=? AND kind<>'fingerprint' ORDER BY id DESC LIMIT 40", [req.site.id]);
  let gh = null; const t = db.dec(req.site.github_token_enc);
  if (req.site.github_repo && t) { try { gh = { repo: await github.repoInfo(t, req.site.github_repo), runs: await github.runs(t, req.site.github_repo, 6), commits: await github.commits(t, req.site.github_repo, 6), pages: await github.pagesInfo(t, req.site.github_repo) }; } catch (e) { gh = null; } }
  res.send(V.syncPage(req.ctx, req.site, logs, gh));
});
app.post("/sites/:slug/sync/run", auth, site, async (req, res) => {
  const r = await sync.syncSafe(req.site, { force: !!req.body.force }); if (req.body.force && !r.error) { try { await sync.syncSite(req.site, { force: true }); } catch (e) {} }
  res.redirect(`/sites/${req.site.slug}/sync?` + (r.error ? "err=" + encodeURIComponent(r.error) : "ok=" + encodeURIComponent(r.note)));
});
app.post("/sites/:slug/deploy", auth, site, async (req, res) => {
  const t = db.dec(req.site.github_token_enc);
  try { await github.dispatch(t, req.site.github_repo, "build.yml", req.site.github_branch || "main"); await db.run("INSERT INTO sync_log (site_id, kind, status, note) VALUES (?,?,?,?)", [req.site.id, "deploy", "ok", "build.yml triggered by hand"]); res.redirect(`/sites/${req.site.slug}/sync?ok=` + encodeURIComponent("Rebuild triggered; it shows under Recent builds in a minute.")); }
  catch (e) { res.redirect(`/sites/${req.site.slug}/sync?err=` + encodeURIComponent(e.message)); }
});
app.get("/sites/:slug/settings", auth, site, async (req, res) => {
  const extra = {}; const ev = await db.get("SELECT COUNT(*) AS c, MAX(ts) AS last FROM events WHERE site_id=?", [req.site.id]); extra.eventsTotal = ev && ev.c; extra.lastEvent = ev && ev.last;
  if (req.query.test) {
    const st = db.dec(req.site.shopify_token_enc), gt = db.dec(req.site.github_token_enc); const errs = [];
    if (req.site.shopify_domain && st) { try { extra.shop = await shopify.shopInfo(req.site.shopify_domain, st); extra.collections = await shopify.listCollections(req.site.shopify_domain, st); } catch (e) { errs.push("Shopify: " + e.message); } }
    if (req.site.github_repo && gt) { try { extra.gh = await github.repoInfo(gt, req.site.github_repo); extra.gh.pages = await github.pagesInfo(gt, req.site.github_repo); } catch (e) { errs.push("GitHub: " + e.message); } }
    if (errs.length) req.query.err = errs.join(" · "); else if (!req.query.ok) req.query.ok = "Connections tested" + (extra.shop ? ": Shopify OK" : "") + (extra.gh ? ", GitHub OK" : "");
  }
  res.send(V.settingsPage(req.ctx, req.site, extra));
});
app.post("/sites/:slug/settings", auth, site, async (req, res) => {
  const b = req.body, s = req.site;
  try { shopifyCred(b); } catch (e) { return res.redirect(`/sites/${s.slug}/settings?err=${encodeURIComponent(e.message)}`); }
  const upd = { name: String(b.name || s.name).trim(), url: String(b.url || "").trim().replace(/\/$/, ""), notes: String(b.notes || ""), github_repo: String(b.github_repo || "").trim(), github_branch: String(b.github_branch || "main").trim() || "main",
    shopify_domain: String(b.shopify_domain || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""), shopify_collection: String(b.shopify_collection_pick || b.shopify_collection || "").trim(), shopify_store_url: String(b.shopify_store_url || "").trim(),
    ga4_measurement: String(b.ga4_measurement || "").trim(), ga4_property: String(b.ga4_property || "").trim(), sync_enabled: b.sync_enabled === "0" ? 0 : 1, sync_weekday: +b.sync_weekday || 0, sync_hour: +b.sync_hour || 0 };
  const cols = Object.keys(upd); const vals = Object.values(upd);
  await db.run(`UPDATE sites SET ${cols.map(c => c + "=?").join(", ")} WHERE id=?`, [...vals, s.id]);
  if (b.github_token) await db.run("UPDATE sites SET github_token_enc=? WHERE id=?", [db.enc(String(b.github_token).trim()), s.id]);
  const cred = shopifyCred(b); if (cred) await db.run("UPDATE sites SET shopify_token_enc=? WHERE id=?", [db.enc(cred), s.id]);
  res.redirect(`/sites/${s.slug}/settings?ok=${encodeURIComponent("Saved")}${b.test ? "&test=1" : ""}`);
});
app.post("/sites/:slug/delete", auth, site, async (req, res) => { for (const t of ["events", "products", "orders", "sync_log", "posts"]) await db.run(`DELETE FROM ${t} WHERE site_id=?`, [req.site.id]); await db.run("DELETE FROM sites WHERE id=?", [req.site.id]); res.redirect("/?ok=" + encodeURIComponent("Site removed")); });

/* ---------- blog ---------- */
const ensureSecret = async site => { if (!site.webhook_secret) { site.webhook_secret = blog.newSecret(); await db.run("UPDATE sites SET webhook_secret=? WHERE id=?", [site.webhook_secret, site.id]); } return site; };
app.get("/sites/:slug/blog", auth, site, async (req, res) => {
  await ensureSecret(req.site);
  const posts = await db.all("SELECT id, slug, title, status, date, author, tags, source, updated_at, commit_sha FROM posts WHERE site_id=? ORDER BY date DESC, id DESC", [req.site.id]);
  const logs = await db.all("SELECT * FROM sync_log WHERE site_id=? AND kind='blog' ORDER BY id DESC LIMIT 12", [req.site.id]);
  res.send(V.blogPage(req.ctx, req.site, posts, logs));
});
app.get("/sites/:slug/blog/new", auth, site, (req, res) => res.send(V.blogEditPage(req.ctx, req.site, null)));
app.get("/sites/:slug/blog/:id/edit", auth, site, async (req, res) => { const p = await db.get("SELECT * FROM posts WHERE id=? AND site_id=?", [req.params.id, req.site.id]); if (!p) return res.status(404).send("No such post"); res.send(V.blogEditPage(req.ctx, req.site, p)); });
app.post("/sites/:slug/blog/save", auth, site, async (req, res) => {
  const p = blog.fromPayload(req.body); const oldSlug = String(req.body.old_slug || "");
  try { const r = await blog.save(req.site, p, "editor", { oldSlug }); res.redirect(`/sites/${req.site.slug}/blog?ok=` + encodeURIComponent(`Saved "${p.title}": ${r.note}`)); }
  catch (e) { res.redirect(`/sites/${req.site.slug}/blog?err=` + encodeURIComponent(e.message)); }
});
app.post("/sites/:slug/blog/:id/delete", auth, site, async (req, res) => {
  const p = await db.get("SELECT * FROM posts WHERE id=? AND site_id=?", [req.params.id, req.site.id]); if (!p) return res.redirect(`/sites/${req.site.slug}/blog`);
  try { await blog.remove(req.site, p); res.redirect(`/sites/${req.site.slug}/blog?ok=` + encodeURIComponent(`Removed "${p.title}"`)); } catch (e) { res.redirect(`/sites/${req.site.slug}/blog?err=` + encodeURIComponent(e.message)); }
});
app.post("/sites/:slug/blog/import", auth, site, async (req, res) => { try { const n = await blog.importFromRepo(req.site); res.redirect(`/sites/${req.site.slug}/blog?ok=` + encodeURIComponent(`Imported ${n} post${n === 1 ? "" : "s"} from the repo`)); } catch (e) { res.redirect(`/sites/${req.site.slug}/blog?err=` + encodeURIComponent(e.message)); } });
app.post("/sites/:slug/blog/secret", auth, site, async (req, res) => { await db.run("UPDATE sites SET webhook_secret=? WHERE id=?", [blog.newSecret(), req.site.id]); res.redirect(`/sites/${req.site.slug}/blog?ok=` + encodeURIComponent("New webhook secret generated. Update it in the tool that sends posts.")); });

/* public webhook: any tool can push a post. Auth: Authorization: Bearer <secret> (or X-Webhook-Secret / ?secret=). */
app.post("/hooks/blog/:key", async (req, res) => {
  const site = await db.get("SELECT * FROM sites WHERE site_key=?", [req.params.key]); if (!site) return res.status(404).json({ ok: false, error: "unknown site key" });
  if (!blog.secretOk(req, site)) return res.status(401).json({ ok: false, error: "bad or missing secret" });
  const b = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : (req.body || {});
  try {
    if (/^delete$/i.test(String(b.action || ""))) {
      const slug = blog.slugify(b.slug || b.title); const p = await db.get("SELECT * FROM posts WHERE site_id=? AND slug=?", [site.id, slug]);
      if (!p) return res.status(404).json({ ok: false, error: "no post with slug " + slug });
      await blog.remove(site, p); return res.json({ ok: true, action: "deleted", slug });
    }
    const p = blog.fromPayload(b); const r = await blog.save(site, p, "webhook");
    res.json({ ok: true, action: r.unchanged ? "unchanged" : "saved", slug: r.post.slug, status: r.post.status, url: r.url, commit: r.commit, build_triggered: r.built, note: r.note });
  } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
});
app.get("/hooks/blog/:key", (req, res) => res.json({ ok: true, hint: "POST JSON here with Authorization: Bearer <webhook secret>. Fields: title, body (markdown or HTML), slug?, excerpt?, image?, tags?, author?, date?, status?, state?, level?, action?: 'delete'" }));

/* JSON for other tools (same cookie auth) */
app.get("/api/sites/:slug/stats", auth, site, async (req, res) => res.json(await stats(req.site.id, req.days)));
app.get("/api/sites/:slug/catalog.js", auth, site, async (req, res) => { const rows = await db.all("SELECT data FROM products WHERE site_id=?", [req.site.id]); res.type("application/javascript").send(shopify.catalogJs(rows.map(r => JSON.parse(r.data)), req.site.name)); });
app.get("/healthz", (req, res) => res.json({ ok: true, db: db.isPg() ? "postgres" : "sqlite" }));

/* ---------- boot ---------- */
(async () => {
  await db.init();
  const email = (process.env.ADMIN_EMAIL || "").toLowerCase().trim(), pw = process.env.ADMIN_PASSWORD || "";
  if (email && pw) { const u = await db.get("SELECT id FROM users WHERE email=?", [email]); if (!u) { await db.run("INSERT INTO users (email, pass_hash) VALUES (?,?)", [email, hashPw(pw)]); console.log("created admin user", email); } else await db.run("UPDATE users SET pass_hash=? WHERE id=?", [hashPw(pw), u.id]); }
  else if (!(await db.get("SELECT id FROM users"))) console.warn("No users: set ADMIN_EMAIL and ADMIN_PASSWORD");
  if (process.env.SCHEDULER !== "off") sync.schedule();
  const port = process.env.PORT || 3000; app.listen(port, () => console.log("dashboard on :" + port, db.isPg() ? "(postgres)" : "(sqlite)"));
})();
