/* One tiny database layer that runs on Postgres (Render) or SQLite (local dev).
   Queries are written with ? placeholders; they are converted to $1,$2 for Postgres. */
const crypto = require("crypto");
const PG_URL = process.env.DATABASE_URL;
let pg = null, sqlite = null;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, role TEXT DEFAULT 'owner', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS sites (id SERIAL PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, url TEXT DEFAULT '', site_key TEXT UNIQUE NOT NULL,
     github_repo TEXT DEFAULT '', github_token_enc TEXT DEFAULT '', github_branch TEXT DEFAULT 'main',
     shopify_domain TEXT DEFAULT '', shopify_token_enc TEXT DEFAULT '', shopify_collection TEXT DEFAULT '', shopify_store_url TEXT DEFAULT '',
     ga4_property TEXT DEFAULT '', ga4_measurement TEXT DEFAULT '',
     sync_weekday INTEGER DEFAULT 1, sync_hour INTEGER DEFAULT 6, sync_enabled INTEGER DEFAULT 1,
     last_sync_at TIMESTAMP, last_sync_status TEXT DEFAULT '', last_sync_note TEXT DEFAULT '', products_count INTEGER DEFAULT 0,
     notes TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
  `CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL, product_id TEXT NOT NULL, handle TEXT, title TEXT, state TEXT, level TEXT, year TEXT, tier TEXT, tier_name TEXT,
     price REAL, compare_at REAL, image TEXT, url TEXT, data TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(site_id, product_id))`,
  `CREATE TABLE IF NOT EXISTS events (id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP, day TEXT NOT NULL, event TEXT NOT NULL, path TEXT DEFAULT '',
     session_id TEXT DEFAULT '', visitor TEXT DEFAULT '', product_id TEXT DEFAULT '', variant_id TEXT DEFAULT '', price REAL DEFAULT 0, state TEXT DEFAULT '', level TEXT DEFAULT '', tier TEXT DEFAULT '',
     location TEXT DEFAULT '', referrer TEXT DEFAULT '', device TEXT DEFAULT '', extra TEXT DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS ev_site_day ON events (site_id, day)`,
  `CREATE INDEX IF NOT EXISTS ev_site_event ON events (site_id, event, day)`,
  `CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL, order_id TEXT NOT NULL, name TEXT, created_at TIMESTAMP, total REAL, currency TEXT, status TEXT, items TEXT, UNIQUE(site_id, order_id))`,
  `CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, status TEXT DEFAULT 'published', date TEXT, author TEXT DEFAULT '', excerpt TEXT DEFAULT '', image TEXT DEFAULT '',
     tags TEXT DEFAULT '', state TEXT DEFAULT '', level TEXT DEFAULT '', body TEXT DEFAULT '', source TEXT DEFAULT 'manual', commit_sha TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(site_id, slug))`,
  `CREATE TABLE IF NOT EXISTS webhook_log (id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP, event TEXT DEFAULT '', status TEXT DEFAULT '', note TEXT DEFAULT '', payload TEXT DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS sync_log (id SERIAL PRIMARY KEY, site_id INTEGER NOT NULL, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP, kind TEXT, status TEXT, note TEXT)`,
];

const MIGRATIONS = [`ALTER TABLE sites ADD COLUMN webhook_secret TEXT DEFAULT ''`, `ALTER TABLE posts ADD COLUMN takeaways TEXT DEFAULT ''`,
  `ALTER TABLE sites ADD COLUMN rankwork_secret_enc TEXT DEFAULT ''`, `ALTER TABLE posts ADD COLUMN external_id TEXT DEFAULT ''`, `ALTER TABLE posts ADD COLUMN kind TEXT DEFAULT 'blog'`,
  `ALTER TABLE posts ADD COLUMN meta_title TEXT DEFAULT ''`, `ALTER TABLE posts ADD COLUMN meta_description TEXT DEFAULT ''`, `ALTER TABLE posts ADD COLUMN old_slugs TEXT DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN source TEXT DEFAULT ''`];
async function init() {
  if (PG_URL) {
    const { Pool } = require("pg");
    pg = new Pool({ connectionString: PG_URL, ssl: PG_URL.includes("localhost") ? false : { rejectUnauthorized: false } });
    for (const s of SCHEMA) await pg.query(s);
    for (const m of MIGRATIONS) await pg.query(m.replace("ADD COLUMN", "ADD COLUMN IF NOT EXISTS"));
  } else {
    const Database = require("better-sqlite3");
    const path = process.env.SQLITE_PATH || require("path").join(__dirname, "..", "data.sqlite");
    sqlite = new Database(path);
    sqlite.pragma("journal_mode = WAL");
    for (const s of SCHEMA) sqlite.exec(s.replace(/SERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT").replace(/CURRENT_TIMESTAMP/g, "@@NOW@@").replace(/TIMESTAMP/g, "TEXT").replace(/@@NOW@@/g, "CURRENT_TIMESTAMP"));
    for (const m of MIGRATIONS) { try { sqlite.exec(m); } catch (e) { /* column exists */ } }
  }
  return module.exports;
}
function toPg(sql) { let i = 0; return sql.replace(/\?/g, () => "$" + (++i)); }
async function all(sql, params = []) {
  if (pg) return (await pg.query(toPg(sql), params)).rows;
  return sqlite.prepare(sql).all(...params);
}
async function get(sql, params = []) { return (await all(sql, params))[0] || null; }
async function run(sql, params = []) {
  if (pg) { const r = await pg.query(toPg(sql) + (/^\s*insert/i.test(sql) && !/returning/i.test(sql) ? " RETURNING id" : ""), params); return { id: r.rows[0] && r.rows[0].id, changes: r.rowCount }; }
  const r = sqlite.prepare(sql).run(...params); return { id: r.lastInsertRowid, changes: r.changes };
}
/* secrets at rest: AES-256-GCM with APP_SECRET */
const KEY = crypto.createHash("sha256").update(process.env.APP_SECRET || "dev-secret-change-me").digest();
function enc(text) { if (!text) return ""; const iv = crypto.randomBytes(12); const c = crypto.createCipheriv("aes-256-gcm", KEY, iv); const out = Buffer.concat([c.update(String(text), "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), out]).toString("base64"); }
function dec(b64) { if (!b64) return ""; try { const b = Buffer.from(b64, "base64"); const d = crypto.createDecipheriv("aes-256-gcm", KEY, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); } catch (e) { return ""; } }
const isPg = () => !!pg;
module.exports = { init, all, get, run, enc, dec, isPg };
