/* GitHub REST: read/commit files, read commits and workflow runs, trigger a workflow. Uses a per-site token (classic or fine-grained, "contents: write" + "actions: write"). */
const BASE = process.env.GITHUB_API || "https://api.github.com";
/* GitHub sometimes answers 502/503/504 ("Could not create file. Please try again later.") or drops the connection
   when it is busy. Those are retried up to 3 times, 2 and 5 seconds apart; any other error is reported at once. */
const RETRY_STATUS = new Set([502, 503, 504]);
const RETRY_WAIT_MS = [2000, 5000];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function gh(token, method, path, body) {
  for (let attempt = 0; ; attempt++) {
    let r;
    try {
      r = await fetch(BASE + path, { method, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "site-dashboard" }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      if (attempt < RETRY_WAIT_MS.length) { await wait(RETRY_WAIT_MS[attempt]); continue; }
      throw new Error(`GitHub unreachable ${path}: ${e.message} (tried ${attempt + 1} times)`);
    }
    if (r.status === 204) return null;
    const d = await r.json().catch(() => ({}));
    if (RETRY_STATUS.has(r.status) && attempt < RETRY_WAIT_MS.length) { await wait(RETRY_WAIT_MS[attempt]); continue; }
    if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status} ${path}: ${(d.message || "").slice(0, 200)}${attempt ? ` (tried ${attempt + 1} times)` : ""}`), { status: r.status });
    return d;
  }
}
const repoInfo = (token, repo) => gh(token, "GET", `/repos/${repo}`);
const commits = (token, repo, n = 8) => gh(token, "GET", `/repos/${repo}/commits?per_page=${n}`);
const runs = (token, repo, n = 8) => gh(token, "GET", `/repos/${repo}/actions/runs?per_page=${n}`).then(d => d.workflow_runs || []);
async function getFile(token, repo, path, branch) {
  try { const d = await gh(token, "GET", `/repos/${repo}/contents/${path}?ref=${branch}`); return { sha: d.sha, content: Buffer.from(d.content || "", "base64").toString("utf8") }; }
  catch (e) { if (/404/.test(e.message)) return null; throw e; }
}
async function putFile(token, repo, path, branch, content, message) {
  const isBuf = Buffer.isBuffer(content);
  // Twice at most: if the file changed between reading and writing (409, for example the site's build bot committed
  // in between, or a retried write had in fact gone through), read it again and write once more.
  for (let attempt = 0; ; attempt++) {
    const cur = await getFile(token, repo, path, branch);
    if (cur && !isBuf && cur.content === content) return { unchanged: true };
    try {
      const d = await gh(token, "PUT", `/repos/${repo}/contents/${path}`, { message, content: (isBuf ? content : Buffer.from(content, "utf8")).toString("base64"), branch, sha: cur ? cur.sha : undefined, committer: { name: "site-dashboard", email: "dashboard@users.noreply.github.com" } });
      return { sha: d.commit && d.commit.sha };
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt === 0) continue;
      throw e;
    }
  }
}
async function deleteFile(token, repo, path, branch, message) {
  const cur = await getFile(token, repo, path, branch); if (!cur) return { missing: true };
  const d = await gh(token, "DELETE", `/repos/${repo}/contents/${path}`, { message, sha: cur.sha, branch, committer: { name: "site-dashboard", email: "dashboard@users.noreply.github.com" } });
  return { sha: d.commit && d.commit.sha };
}
async function listDir(token, repo, path, branch) {
  try { const d = await gh(token, "GET", `/repos/${repo}/contents/${path}?ref=${branch}`); return Array.isArray(d) ? d.map(f => ({ name: f.name, path: f.path, sha: f.sha, size: f.size })) : []; }
  catch (e) { if (/404/.test(e.message)) return []; throw e; }
}
const dispatch = (token, repo, workflow, branch, inputs) => gh(token, "POST", `/repos/${repo}/actions/workflows/${workflow}/dispatches`, { ref: branch, inputs: inputs || {} });
const pagesInfo = (token, repo) => gh(token, "GET", `/repos/${repo}/pages`).catch(() => null);
module.exports = { repoInfo, commits, runs, getFile, putFile, deleteFile, listDir, dispatch, pagesInfo };
