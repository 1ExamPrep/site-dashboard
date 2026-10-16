/* Blog posts: stored in the dashboard, published as content/posts/<slug>.md in the site repo, then build.yml renders /blog/.
   Posts arrive from the editor in the dashboard or from the public webhook  POST /hooks/blog/<site key>  (see README). */
const crypto = require("crypto");
const db = require("./db"), github = require("./github");

const slugify = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: process.env.TZ_NAME || "America/Chicago" });
const tagsOf = t => Array.isArray(t) ? t.map(x => String(x).trim()).filter(Boolean) : String(t || "").split(/[,;]/).map(x => x.trim()).filter(Boolean);

/* normalise any payload (webhook JSON, form body) into a post */
function fromPayload(b) {
  const title = String(b.title || b.headline || b.name || "").trim();
  const body = String(b.body || b.content || b.markdown || b.html || b.text || "").replace(/\r\n/g, "\n").trim();
  const date = String(b.date || b.published_at || b.publishedAt || "").slice(0, 10);
  return {
    title, body, slug: slugify(b.slug || title), date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : today(),
    status: /^draft$/i.test(String(b.status || "")) || b.draft === true ? "draft" : "published",
    author: String(b.author || "").trim(), excerpt: String(b.excerpt || b.description || b.summary || "").trim().slice(0, 300),
    image: String(b.image || b.cover || b.featured_image || b.imageUrl || "").trim(), tags: tagsOf(b.tags || b.keywords).join(", "),
    state: String(b.state || "").trim(), level: String(b.level || "").trim(),
  };
}

/* the markdown file build.py reads */
function fileFor(p) {
  const fm = [["title", p.title], ["date", p.date], ["author", p.author], ["excerpt", p.excerpt.replace(/\n/g, " ")], ["image", p.image], ["tags", p.tags], ["state", p.state], ["level", p.level], ["status", p.status], ["updated", today()]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${String(v).replace(/\n/g, " ")}`).join("\n");
  return `---\n${fm}\n---\n${p.body}\n`;
}
function parseFile(text) {
  const m = text.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*\n?/); const meta = {}; let body = text;
  if (m) { for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); } body = text.slice(m[0].length); }
  return { ...meta, body: body.trim() };
}

async function save(site, p, source, opts = {}) {
  if (!p.title) throw Object.assign(new Error("title is required"), { status: 400 });
  if (!p.body) throw Object.assign(new Error("body is required"), { status: 400 });
  if (!p.slug) p.slug = slugify(p.title) || "post";
  const cur = await db.get("SELECT id, slug FROM posts WHERE site_id=? AND slug=?", [site.id, p.slug]);
  const cols = ["title", "status", "date", "author", "excerpt", "image", "tags", "state", "level", "body"];
  if (cur) await db.run(`UPDATE posts SET ${cols.map(c => c + "=?").join(", ")}, source=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...cols.map(c => p[c]), source, cur.id]);
  else await db.run(`INSERT INTO posts (site_id, slug, ${cols.join(", ")}, source) VALUES (?,?,${cols.map(() => "?").join(",")},?)`, [site.id, p.slug, ...cols.map(c => p[c]), source]);
  const row = await db.get("SELECT * FROM posts WHERE site_id=? AND slug=?", [site.id, p.slug]);
  const pub = await publish(site, row, opts.oldSlug);
  return { post: row, ...pub };
}

/* commit the file (and remove the old one on a rename), trigger the build */
async function publish(site, row, oldSlug) {
  const token = db.dec(site.github_token_enc);
  if (!site.github_repo || !token) return { published: false, note: "stored in the dashboard only; connect GitHub in Settings to publish" };
  const branch = site.github_branch || "main", path = `content/posts/${row.slug}.md`;
  if (oldSlug && oldSlug !== row.slug) await github.deleteFile(token, site.github_repo, `content/posts/${oldSlug}.md`, branch, `Blog: rename ${oldSlug} -> ${row.slug}`).catch(() => {});
  const r = await github.putFile(token, site.github_repo, path, branch, fileFor(row), `Blog: ${row.status === "draft" ? "draft" : "publish"} "${row.title.slice(0, 60)}"`);
  let built = false;
  if (!r.unchanged) { try { await github.dispatch(token, site.github_repo, "build.yml", branch); built = true; } catch (e) {} }
  if (r.sha) await db.run("UPDATE posts SET commit_sha=? WHERE id=?", [r.sha, row.id]);
  await db.run("INSERT INTO sync_log (site_id, kind, status, note) VALUES (?,?,?,?)", [site.id, "blog", "ok", r.unchanged ? `"${row.title.slice(0, 50)}" unchanged` : `${row.status === "draft" ? "Draft saved" : "Published"} "${row.title.slice(0, 50)}" (${row.source})${built ? ", build triggered" : ""}`]);
  const url = row.status === "published" && site.url ? `${site.url.replace(/\/$/, "")}/blog/${row.slug}/` : "";
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
    const cols = ["title", "status", "date", "author", "excerpt", "image", "tags", "state", "level", "body"];
    if (cur) await db.run(`UPDATE posts SET ${cols.map(c => c + "=?").join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [...cols.map(c => p[c]), cur.id]);
    else await db.run(`INSERT INTO posts (site_id, slug, ${cols.join(", ")}, source) VALUES (?,?,${cols.map(() => "?").join(",")},?)`, [site.id, slug, ...cols.map(c => p[c]), "repo"]);
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
module.exports = { fromPayload, fileFor, parseFile, save, publish, remove, importFromRepo, newSecret, secretOk, slugify };
