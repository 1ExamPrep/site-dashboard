/* Blog posts: stored in the dashboard, published as content/posts/<slug>.md in the site repo, then build.yml renders /blog/.
   Posts arrive from the editor in the dashboard or from the public webhook  POST /hooks/blog/<site key>  (see README). */
const crypto = require("crypto");
const db = require("./db"), github = require("./github");

const slugify = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ_NAME || "America/Chicago" });
const tagsOf = t => Array.isArray(t) ? t.map(x => String(x).trim()).filter(Boolean) : String(t || "").split(/[,;]/).map(x => x.trim()).filter(Boolean);

/* normalise any payload (webhook JSON from any tool, or the editor form) into a post */
const str = v => { if (v == null) return ""; if (typeof v === "object") { if (Array.isArray(v)) return ""; return str(v.url || v.src || v.href || v.html || v.markdown || v.text || v.value || v.name || v.title || ""); } return String(v); };
function pick(o, keys) { for (const k of keys) { const v = str(o && o[k]); if (v.trim()) return v.trim(); } return ""; }
function unwrap(b) {
  // tools often nest the record: {event, data:{…}} / {page:{…}} / {post:{…}} / {payload:{…}}
  let o = b && typeof b === "object" ? b : {}; const ev = pick(o, ["event", "type", "topic", "event_type"]);
  for (let i = 0; i < 3; i++) { const inner = ["data", "page", "post", "article", "payload", "record", "item", "object", "result", "content"].map(k => o[k]).find(v => v && typeof v === "object" && !Array.isArray(v) && (v.title || v.headline || v.body || v.html || v.content || v.markdown)); if (!inner) break; o = { ...o, ...inner }; }
  return { o, ev };
}
function fromPayload(b) {
  const { o, ev } = unwrap(b);
  const title = pick(o, ["title", "headline", "name", "seo_title", "h1", "page_title"]);
  const body = pick(o, ["body", "content", "markdown", "html", "body_html", "content_html", "article", "text", "body_markdown", "content_markdown"]).replace(/\r\n/g, "\n");
  const date = pick(o, ["date", "published_at", "publishedAt", "publish_date", "created_at", "createdAt"]).slice(0, 10);
  const rawSlug = pick(o, ["slug", "handle", "path", "url_slug"]); const slugSrc = rawSlug ? rawSlug.replace(/\/+$/, "").split("/").pop() : title;
  const tagsRaw = o.tags || o.keywords || o.categories || o.topics; const tags = Array.isArray(tagsRaw) ? tagsRaw.map(t => typeof t === "object" ? str(t) : String(t)) : tagsRaw;
  const status = pick(o, ["status", "state_name"]);
  return {
    title, body, slug: slugify(slugSrc), date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today(),
    status: /draft|unpublish|pending|hidden/i.test(status) || o.draft === true || o.published === false ? "draft" : "published",
    author: pick(o, ["author", "author_name", "byline", "writer"]), excerpt: pick(o, ["excerpt", "description", "meta_description", "summary", "seo_description", "subtitle"]).slice(0, 300),
    image: pick(o, ["image", "cover", "featured_image", "imageUrl", "image_url", "og_image", "hero_image", "thumbnail", "cover_image"]), tags: tagsOf(tags).join(", "),
    state: pick(o, ["state", "us_state"]), level: pick(o, ["level", "license_level"]), event: ev,
    takeaways: (() => { const t = o.takeaways || o.key_takeaways || o.key_points || o.summary_points || o.tldr; return (Array.isArray(t) ? t.map(x => str(x).trim()).filter(Boolean) : String(t || "").split(/\s*[|\n]\s*/).map(x => x.trim()).filter(Boolean)).slice(0, 4).join(" | "); })(),
  };
}

/* ---------- Rankwork (rankwork.com) signed webhooks ---------- */
function verifyRankwork(rawBody, header, secret) {
  try {
    const parts = Object.fromEntries(String(header || "").split(",").map(x => x.trim().split("=")));
    const ts = Number(parts.t); if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return { ok: false, why: "timestamp missing or older than five minutes" };
    const expected = crypto.createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
    const given = String(parts.v1 || ""); if (given.length !== expected.length) return { ok: false, why: "signature does not match" };
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given)) ? { ok: true } : { ok: false, why: "signature does not match" };
  } catch (e) { return { ok: false, why: "malformed signature header" }; }
}
const textOf = h => String(h || "").replace(/<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").replace(/^summary\s*:?\s*/i, "").trim();
/* page.publish payload -> post (see Rankwork docs: pageId, kind, title, handle, metaTitle, metaDescription, summaryHtml, html, author, tags, heroImageBase64, updatedAt) */
function fromRankwork(d) {
  d = d || {};
  const title = String(d.title || d.metaTitle || "").trim(), html = String(d.html || "").trim();
  const date = String(d.updatedAt || d.publishedAt || "").slice(0, 10);
  let image = null;
  if (d.heroImageBase64 && typeof d.heroImageBase64 === "string") { try { const buf = Buffer.from(d.heroImageBase64.replace(/^data:[^,]+,/, ""), "base64"); if (buf.length > 100 && buf.length <= 2 * 1024 * 1024) image = { buffer: buf, ext: buf[0] === 0xff && buf[1] === 0xd8 ? "jpg" : "png" }; } catch (e) {} }
  return {
    title, body: html, slug: slugify(d.handle || title), external_id: String(d.pageId || ""), kind: /^page$/i.test(String(d.kind || "")) ? "page" : "blog",
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today(), status: "published", author: String(d.author || "").trim(),
    excerpt: (textOf(d.summaryHtml) || String(d.metaDescription || "").trim()).slice(0, 300), meta_title: String(d.metaTitle || "").trim().slice(0, 70), meta_description: String(d.metaDescription || "").trim().slice(0, 170),
    image: "", tags: tagsOf(d.tags).join(", "), state: "", level: "", takeaways: "", event: "page.publish", keyword: String(d.keyword || ""), heroNote: d.heroNote || "", imageFile: image,
  };
}

/* the markdown file build.py reads */
function fileFor(p) {
  const fm = [["title", p.title], ["date", p.date], ["author", p.author], ["excerpt", (p.excerpt || "").replace(/\n/g, " ")], ["image", p.image], ["tags", p.tags], ["state", p.state], ["level", p.level], ["takeaways", p.takeaways || ""],
    ["kind", p.kind && p.kind !== "blog" ? p.kind : ""], ["metaTitle", p.meta_title || ""], ["metaDescription", p.meta_description || ""], ["externalId", p.external_id || ""], ["status", p.status], ["updated", today()]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`).join("\n");
  return `---\n${fm}\n---\n${p.body}\n`;
}
function parseFile(text) {
  const m = text.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*\n?/); const meta = {}; let body = text;
  if (m) { for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); } body = text.slice(m[0].length); }
  return { ...meta, body: body.trim() };
}

const COLS = ["title", "status", "date", "author", "excerpt", "image", "tags", "state", "level", "takeaways", "body", "kind", "meta_title", "meta_description", "external_id"];
/* store a post. opts: { oldSlug, imageFile:{buffer,ext}, background:true } -> background resolves the GitHub part after returning */
async function store(site, p, source, opts = {}) {
  if (!p.title) throw Object.assign(new Error("title is required"), { status: 400 });
  if (!p.body) throw Object.assign(new Error("body is required"), { status: 400 });
  if (!p.slug) p.slug = slugify(p.title) || "post";
  p.kind = p.kind || "blog"; p.meta_title = p.meta_title || ""; p.meta_description = p.meta_description || ""; p.external_id = p.external_id || "";
  if (p.state && !/^[A-Za-z .]{2,30}$/.test(p.state)) p.state = "";
  // same external id (Rankwork pageId) = same post, even if the handle changed
  let cur = p.external_id ? await db.get("SELECT * FROM posts WHERE site_id=? AND external_id=?", [site.id, p.external_id]) : null;
  if (!cur) cur = await db.get("SELECT * FROM posts WHERE site_id=? AND slug=?", [site.id, p.slug]);
  let oldSlug = opts.oldSlug || ""; let oldSlugs = cur && cur.old_slugs ? cur.old_slugs.split(",").filter(Boolean) : [];
  if (cur && cur.slug !== p.slug) { oldSlug = cur.slug; if (!oldSlugs.includes(cur.slug)) oldSlugs.push(cur.slug); }
  oldSlugs = oldSlugs.filter(x => x !== p.slug);
  const imgExt = opts.imageFile ? opts.imageFile.ext : (p.imageFile ? p.imageFile.ext : null); const imageFile = opts.imageFile || p.imageFile || null;
  if (imageFile) p.image = `/content/images/${p.slug}.${imgExt}`;  // site-relative; build.py makes it absolute for og:image and schema
  else if (cur && !p.image) p.image = cur.image || "";
  if (cur) await db.run(`UPDATE posts SET ${COLS.map(c => c + "=?").join(", ")}, slug=?, old_slugs=?, source=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...COLS.map(c => p[c] || ""), p.slug, oldSlugs.join(","), source, cur.id]);
  else await db.run(`INSERT INTO posts (site_id, slug, old_slugs, ${COLS.join(", ")}, source) VALUES (?,?,?,${COLS.map(() => "?").join(",")},?)`, [site.id, p.slug, oldSlugs.join(","), ...COLS.map(c => p[c] || ""), source]);
  const row = await db.get("SELECT * FROM posts WHERE site_id=? AND slug=?", [site.id, p.slug]);
  return { row, oldSlug, imageFile };
}
async function save(site, p, source, opts = {}) {
  const { row, oldSlug, imageFile } = await store(site, p, source, opts);
  const pub = await publish(site, row, oldSlug, imageFile);
  return { post: row, ...pub };
}
const postUrl = (site, row) => !site.url || row.status !== "published" ? "" : `${site.url.replace(/\/$/, "")}/${row.kind === "page" ? "pages" : "blog"}/${row.slug}/`;

/* commit the file (and the hero image, a redirect for a renamed slug), trigger the build */
async function publish(site, row, oldSlug, imageFile) {
  const token = db.dec(site.github_token_enc);
  if (!site.github_repo || !token) return { published: false, note: "stored in the dashboard only; connect GitHub in Settings to publish", url: "" };
  const branch = site.github_branch || "main", path = `content/posts/${row.slug}.md`;
  if (imageFile) { try { await github.putFile(token, site.github_repo, `content/images/${row.slug}.${imageFile.ext}`, branch, imageFile.buffer, `Blog: image for "${row.title.slice(0, 50)}"`); } catch (e) { await db.run("INSERT INTO sync_log (site_id, kind, status, note) VALUES (?,?,?,?)", [site.id, "blog", "error", "image upload failed: " + e.message.slice(0, 200)]); } }
  if (oldSlug && oldSlug !== row.slug) {
    await github.deleteFile(token, site.github_repo, `content/posts/${oldSlug}.md`, branch, `Blog: rename ${oldSlug} -> ${row.slug}`).catch(() => {});
    try { // old URL keeps working: content/redirects.json is turned into redirect pages by build.py
      const cur = await github.getFile(token, site.github_repo, "content/redirects.json", branch); let map = {}; try { map = cur ? JSON.parse(cur.content) : {}; } catch (e) {}
      map[`${row.kind === "page" ? "pages" : "blog"}/${oldSlug}/`] = `${row.kind === "page" ? "pages" : "blog"}/${row.slug}/`;
      for (const k of Object.keys(map)) if (map[k] === `${row.kind === "page" ? "pages" : "blog"}/${oldSlug}/`) map[k] = `${row.kind === "page" ? "pages" : "blog"}/${row.slug}/`;
      await github.putFile(token, site.github_repo, "content/redirects.json", branch, JSON.stringify(map, null, 1) + "\n", `Blog: redirect ${oldSlug} -> ${row.slug}`);
    } catch (e) {}
  }
  const r = await github.putFile(token, site.github_repo, path, branch, fileFor(row), `Blog: ${row.status === "draft" ? "draft" : "publish"} "${row.title.slice(0, 60)}"`);
  let built = false;
  if (!r.unchanged) { try { await github.dispatch(token, site.github_repo, "build.yml", branch); built = true; } catch (e) {} }
  if (r.sha) await db.run("UPDATE posts SET commit_sha=? WHERE id=?", [r.sha, row.id]);
  await db.run("INSERT INTO sync_log (site_id, kind, status, note) VALUES (?,?,?,?)", [site.id, "blog", "ok", r.unchanged ? `"${row.title.slice(0, 50)}" unchanged` : `${row.status === "draft" ? "Draft saved" : "Published"} "${row.title.slice(0, 50)}" (${row.source})${built ? ", build triggered" : ""}`]);
  const url = postUrl(site, row);
  return { published: !r.unchanged, unchanged: !!r.unchanged, commit: r.sha || "", built, url, note: r.unchanged ? "nothing changed" : built ? "committed; the site rebuilds in about a minute" : "committed" };
}

async function remove(site, row) {
  const token = db.dec(site.github_token_enc);
  if (site.github_repo && token) await github.deleteFile(token, site.github_repo, `content/posts/${row.slug}.md`, site.github_branch || "main", `Blog: remove "${row.title.slice(0, 60)}"`).then(async r => { if (!r.missing) { try { await github.dispatch(token, site.github_repo, "build.yml", site.github_branch || "main"); } catch (e) {} } });
  await db.run("DELETE FROM posts WHERE id=?", [row.id]);
  await db.run("INSERT INTO sync_log (site_id, kind, status, note) VALUES (?,?,?,?)", [site.id, "blog", "ok", `Removed "${row.title.slice(0, 50)}"`]);
}

/* pull posts that already exist in the repo (written by hand or before the dashboard) */
async function importFromRepo(site) {
  const token = db.dec(site.github_token_enc); if (!site.github_repo || !token) throw new Error("Connect GitHub first");
  const files = await github.listDir(token, site.github_repo, "content/posts", site.github_branch || "main"); let n = 0;
  for (const f of files.filter(f => f.name.endsWith(".md"))) {
    const g = await github.getFile(token, site.github_repo, f.path, site.github_branch || "main"); if (!g) continue;
    const m = parseFile(g.content), slug = slugify(m.slug || f.name.replace(/\.md$/, ""));
    const p = { ...fromPayload({ ...m, slug }), slug }; if (!p.title) continue;
    const cur = await db.get("SELECT id FROM posts WHERE site_id=? AND slug=?", [site.id, slug]);
    p.kind = m.kind || "blog"; p.meta_title = m.metatitle || ""; p.meta_description = m.metadescription || ""; p.external_id = m.externalid || "";
    if (cur) await db.run(`UPDATE posts SET ${COLS.map(c => c + "=?").join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...COLS.map(c => p[c] || ""), cur.id]);
    else await db.run(`INSERT INTO posts (site_id, slug, ${COLS.join(", ")}, source) VALUES (?,?,${COLS.map(() => "?").join(",")},?)`, [site.id, slug, ...COLS.map(c => p[c] || ""), "repo"]);
    n++;
  }
  return n;
}

const newSecret = () => "whs_" + crypto.randomBytes(18).toString("hex");
function secretOk(req, site) {
  const given = String((req.headers.authorization || "").replace(/^Bearer\s+/i, "") || req.headers["x-webhook-secret"] || req.query.secret || (req.body && req.body.secret) || "").trim();
  if (!site.webhook_secret || !given || given.length !== site.webhook_secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(site.webhook_secret));
}
/* turn a Shopify article into a post payload */
function fromArticle(a, extra = {}) {
  return fromPayload({ title: a.title, body: a.body || "", slug: a.handle, excerpt: a.summary ? a.summary.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "", image: a.image && a.image.url, tags: a.tags || [],
    author: a.author && a.author.name, date: a.publishedAt, status: a.isPublished === false ? "draft" : "published", ...extra });
}
/* webhook pings without a body (Rankwork, Shopify flow, etc.): pull the article from Shopify, or scrape the public page */
async function fetchFromSource(site, b, p) {
  const o = (b && b.data && typeof b.data === "object") ? b.data : (b || {});
  const admin = String(o.adminUrl || o.admin_url || "");
  const m = admin.match(/\/articles\/(\d+)/) || String(o.articleId || o.article_id || "").match(/(\d+)$/);
  const cred = db.dec(site.shopify_token_enc); const shopify = require("./shopify");
  if (m && site.shopify_domain && cred) {
    try { const a = await shopify.getArticle(site.shopify_domain, cred, m[1]); if (a && a.body) return { post: fromArticle(a, { tags: a.tags && a.tags.length ? a.tags : p.tags }), via: "shopify article " + m[1] }; }
    catch (e) { var shopErr = e.message; }
  }
  const url = String(o.url || o.link || o.permalink || "");
  if (/^https?:\/\//.test(url) && !/example\.com/.test(url)) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "site-dashboard/1.0" }, redirect: "follow" }); const html = await r.text();
      const meta = (n) => { const mm = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]+content=["']([^"']+)`, "i")) || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${n}["']`, "i")); return mm ? mm[1] : ""; };
      let body = ""; const cand = html.match(/<div[^>]+class=["'][^"']*(?:article__content|article-content|rte|blog-post__content|article__body)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<footer|<section|<aside|<\/article)/i) || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
      if (cand) body = cand[1].replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").trim();
      if (body.replace(/<[^>]+>/g, "").trim().length > 200) return { post: fromPayload({ title: p.title || meta("og:title"), body, excerpt: meta("og:description") || meta("description"), image: meta("og:image"), tags: p.tags, author: p.author, date: p.date, slug: url.replace(/\/+$/, "").split("/").pop() }), via: "public page" };
    } catch (e) { var pageErr = e.message; }
  }
  return { post: null, reason: [m ? "" : "no Shopify article id in the payload", shopErr ? "Shopify: " + shopErr : "", pageErr ? "page: " + pageErr : "", "the app needs the read_content scope to read blog articles"].filter(Boolean).join("; ") };
}
async function logHook(siteId, event, status, note, payload) { try { await db.run("INSERT INTO webhook_log (site_id, event, status, note, payload) VALUES (?,?,?,?,?)", [siteId, String(event || "").slice(0, 80), status, String(note || "").slice(0, 500), JSON.stringify(payload).slice(0, 6000)]); await db.run("DELETE FROM webhook_log WHERE site_id=? AND id NOT IN (SELECT id FROM webhook_log WHERE site_id=? ORDER BY id DESC LIMIT 30)", [siteId, siteId]); } catch (e) {} }
module.exports = { logHook, verifyRankwork, fromRankwork, store, postUrl, fromArticle, fetchFromSource, fromPayload, fileFor, parseFile, save, publish, remove, importFromRepo, newSecret, secretOk, slugify };
