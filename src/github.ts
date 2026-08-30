import type { Env } from "./types";

const GITHUB_API = "https://api.github.com";

function headers(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cloudflare-github-agent",
  };
}

async function ghFetch(
  env: Env,
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...options,
    headers: { ...headers(env), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res.status === 204 ? null : res.json();
}

// Repo

export async function createRepo(
  env: Env,
  name: string,
  isPrivate: boolean
): Promise<any> {
  return ghFetch(env, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
    headers: { "Content-Type": "application/json" },
  });
}

// Branch

export async function createBranch(
  env: Env,
  owner: string,
  repo: string,
  branch: string,
  from?: string
): Promise<any> {
  const ref = from || "main";
  const refData = await ghFetch(env, `/repos/${owner}/${repo}/git/refs/heads/${ref}`);
  const sha = refData.object.sha;
  return ghFetch(env, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function deleteBranch(
  env: Env,
  owner: string,
  repo: string,
  branch: string
): Promise<void> {
  await ghFetch(env, `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
}

// Files

export async function getFile(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<{ content: string; sha: string }> {
  const q = ref ? `?ref=${ref}` : "";
  const data = await ghFetch(env, `/repos/${owner}/${repo}/contents/${path}${q}`);
  const content = atob(data.content.replace(/\n/g, ""));
  return { content, sha: data.sha };
}

export async function createOrUpdateFile(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch?: string,
  sha?: string
): Promise<any> {
  const body: Record<string, any> = { message, content: btoa(content) };
  if (branch) body.branch = branch;
  if (sha) body.sha = sha;
  return ghFetch(env, `/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

export async function deleteFile(
  env: Env,
  owner: string,
  repo: string,
  path: string,
  sha: string,
  branch?: string
): Promise<void> {
  const body: Record<string, any> = { message: `Delete ${path}`, sha };
  if (branch) body.branch = branch;
  await ghFetch(env, `/repos/${owner}/${repo}/contents/${path}`, {
    method: "DELETE",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

export async function listFiles(
  env: Env,
  owner: string,
  repo: string,
  ref?: string
): Promise<any[]> {
  const q = ref ? `?ref=${ref}` : "";
  return ghFetch(env, `/repos/${owner}/${repo}/contents${q}`);
}

// Pull Requests

export async function createPullRequest(
  env: Env,
  owner: string,
  repo: string,
  title: string,
  head: string,
  base: string,
  body?: string
): Promise<any> {
  return ghFetch(env, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body: body || "" }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function listPullRequests(
  env: Env,
  owner: string,
  repo: string,
  state: string
): Promise<any[]> {
  return ghFetch(env, `/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`);
}

export async function mergePullRequest(
  env: Env,
  owner: string,
  repo: string,
  number: number,
  method: string
): Promise<any> {
  return ghFetch(env, `/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: method }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function getPullRequestFiles(
  env: Env,
  owner: string,
  repo: string,
  number: number
): Promise<any[]> {
  return ghFetch(env, `/repos/${owner}/${repo}/pulls/${number}/files`);
}

export async function getPullRequest(
  env: Env,
  owner: string,
  repo: string,
  number: number
): Promise<any> {
  return ghFetch(env, `/repos/${owner}/${repo}/pulls/${number}`);
}

// Issues

export async function createIssue(
  env: Env,
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels?: string[]
): Promise<any> {
  const payload: Record<string, any> = { title, body };
  if (labels && labels.length > 0) payload.labels = labels;
  return ghFetch(env, `/repos/${owner}/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
  });
}

export async function listIssues(
  env: Env,
  owner: string,
  repo: string,
  state: string
): Promise<any[]> {
  return ghFetch(env, `/repos/${owner}/${repo}/issues?state=${state}&per_page=20`);
}

export async function closeIssue(
  env: Env,
  owner: string,
  repo: string,
  number: number
): Promise<any> {
  return ghFetch(env, `/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
    headers: { "Content-Type": "application/json" },
  });
}

export async function commentIssue(
  env: Env,
  owner: string,
  repo: string,
  number: number,
  body: string
): Promise<any> {
  return ghFetch(env, `/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
    headers: { "Content-Type": "application/json" },
  });
}
