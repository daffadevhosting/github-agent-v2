import type { Env } from "./types";

const GITHUB_API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cloudflare-github-agent-app",
  };
}

async function ghFetch(token: string, path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: { ...headers(token), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    let parsed: any = {};
    try { parsed = JSON.parse(body); } catch {}
    throw new Error(parsed.message || `GitHub API ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// Repositori
export async function createRepo(token: string, name: string, isPrivate: boolean): Promise<any> {
  return ghFetch(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
    headers: { "Content-Type": "application/json" },
  });
}

// Branch
export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  from = "main"
): Promise<any> {
  const ref = await ghFetch(token, `/repos/${owner}/${repo}/git/ref/heads/${from}`);
  const sha = ref.object.sha;
  return ghFetch(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function deleteBranch(token: string, owner: string, repo: string, branch: string): Promise<any> {
  return ghFetch(token, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "DELETE",
  });
}

// File
export async function createOrUpdateFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch = "main"
): Promise<any> {
  let sha: string | undefined;
  try {
    const existing = await ghFetch(token, `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
    sha = existing.sha;
  } catch {}

  const encoded = btoa(unescape(encodeURIComponent(content)));
  const payload: Record<string, any> = { message, content: encoded, branch };
  if (sha) payload.sha = sha;

  return ghFetch(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
}

export async function getFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch = "main"
): Promise<{ content: string; sha: string }> {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
  const raw = atob(res.content.replace(/\n/g, ""));
  const content = decodeURIComponent(escape(raw));
  return { content, sha: res.sha };
}

export async function deleteFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  message: string,
  branch = "main"
): Promise<any> {
  const file = await getFile(token, owner, repo, path, branch);
  return ghFetch(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha: file.sha, branch }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function listFiles(
  token: string,
  owner: string,
  repo: string,
  branch = "main"
): Promise<string[]> {
  try {
    const tree = await ghFetch(token, `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
    return (tree.tree || [])
      .filter((node: any) => node.type === "blob")
      .map((node: any) => node.path);
  } catch {
    return [];
  }
}

// Pull Request
export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  title: string,
  head: string,
  base = "main",
  body = ""
): Promise<any> {
  return ghFetch(token, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function listPullRequests(
  token: string,
  owner: string,
  repo: string,
  state = "open"
): Promise<any[]> {
  return ghFetch(token, `/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`);
}

export async function mergePullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
  commitMessage?: string
): Promise<any> {
  const payload: Record<string, any> = {};
  if (commitMessage) payload.commit_message = commitMessage;
  return ghFetch(token, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
}

export async function getPullRequestFiles(
  token: string,
  owner: string,
  repo: string,
  number: number
): Promise<any[]> {
  return ghFetch(token, `/repos/${owner}/${repo}/pulls/${number}/files`);
}

// Issues
export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels?: string[]
): Promise<any> {
  const payload: Record<string, any> = { title, body };
  if (labels && labels.length > 0) payload.labels = labels;
  return ghFetch(token, `/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
}

export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  state = "open"
): Promise<any[]> {
  return ghFetch(token, `/repos/${owner}/${repo}/issues?state=${state}&per_page=20`);
}

export async function closeIssue(
  token: string,
  owner: string,
  repo: string,
  number: number
): Promise<any> {
  return ghFetch(token, `/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
    headers: { "Content-Type": "application/json" },
  });
}
