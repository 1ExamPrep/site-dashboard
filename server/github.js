/* GitHub REST: read/commit files, read commits and workflow runs, trigger a workflow. Uses a per-site token (classic or fine-grained, "contents: write" + "actions: write"). */
const BASE = process.env.GITHUB_API || "https://api.github.com";
async function gh(token, method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "site-dashboard" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 204) return null;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status} ${path}: ${(d.message || "").slice(0, 200)}`);
  return d;
}
const repoInfo = (token, repo) => gh(token, "GET", `/repos/${repo}`);
const commits = (token, repo, n = 8) => gh(token, "GET", `/repos/${repo}/commits?per_page=${n}`);
const runs = (token, repo, n = 8) => gh(token, "GET", `/repos/${repo}/actions/runs?per_page=${n}`).then(d => d.workflow_runs || []);
async function getFile(token, repo, path, branch) {
  try { const d = await gh(token, "GET", `/repos/${repo}/contents/${path}?ref=${branch}`); return { sha: d.sha, content: Buffer.from(d.content || "", "base64").toString("utf8") }; }
  catch (e) { if (/404/.test(e.message)) return null; throw e; }
}
async function putFile(token, repo, path, branch, content, message) {
  const cur = await getFile(token, repo, path, branch);
  if (cur && cur.content === content) return { unchanged: true };
  const d = await gh(token, "PUT", `/repos/${repo}/contents/${path}`, { message, content: Buffer.from(content, "utf8").toString("base64"), branch, sha: cur ? cur.sha : undefined, committer: { name: "site-dashboard", email: "dashboard@users.noreply.github.com" } });
  return { sha: d.commit && d.commit.sha };
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
