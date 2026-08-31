const GITHUB_API = "https://api.github.com";

const BOT_COMMITTER = {
  name: "GitHub Agent [bot]",
  email: "github-agent-bot@users.noreply.github.com",
};

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

/**
 * Mengambil seluruh repositori milik pengguna yang sedang login
 */
export async function listUserRepositories(token: string): Promise<any[]> {
  const repos = await ghFetch(token, "/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator");
  return (repos || []).map((r: any) => ({
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    owner: r.owner?.login,
    description: r.description,
    private: r.private,
    language: r.language,
    stars: r.stargazers_count,
    default_branch: r.default_branch || "main",
    html_url: r.html_url,
  }));
}

/**
 * Mengambil default branch dari repositori secara dinamis
 */
export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string
): Promise<string> {
  try {
    const repoInfo = await ghFetch(token, `/repos/${owner}/${repo}`);
    return repoInfo.default_branch || "github-agent";
  } catch {
    return "github-agent";
  }
}

/**
 * Format nama branch dengan brand agen jika dibuat dari WebApp/Agent
 */
export function formatAgentBranchName(name?: string): string {
  const sanitize = (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\-_/]/g, "-")
    .replace(/^-+|-+$/g, "");

  const timestamp = Date.now().toString(36);
  const branchSlug = sanitize || `patch-${timestamp}`;

  return branchSlug.startsWith("github-agent/")
    ? branchSlug
    : `github-agent/${branchSlug}`;
}

/**
 * Mengambil struktur pohon berkas (file tree) lengkap dari repositori secara dinamis
 */
export async function getRepoTree(
  token: string,
  owner: string,
  repo: string,
  branch?: string
): Promise<{ path: string; name: string; type: string; lang: string }[]> {
  try {
    // Jika branch tidak diisi, ambil default_branch secara dinamis
    const targetBranch = branch || (await getDefaultBranch(token, owner, repo));
    const tree = await ghFetch(token, `/repos/${owner}/${repo}/git/trees/${targetBranch}?recursive=1`);
    
    return (tree.tree || [])
      .filter((node: any) => node.type === "blob")
      .map((node: any) => {
        const ext = node.path.split(".").pop()?.toLowerCase() || "";
        return {
          path: node.path,
          name: node.path.split("/").pop() || node.path,
          type: "file",
          lang: ext,
        };
      });
  } catch (err) {
    console.warn("Gagal mengambil tree repositori:", err);
    return [];
  }
}

// Repositori
export async function createRepo(token: string, name: string, isPrivate: boolean): Promise<any> {
  return ghFetch(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Membuat branch baru dengan nama bermerek (github-agent/...) dan dari branch utama yang dinamis
 */
export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  from?: string
): Promise<any> {
  // 1. Dapatkan nama base branch secara dinamis jika tidak ditentukan
  const baseBranch = from || (await getDefaultBranch(token, owner, repo));

  // 2. Terapkan prefix brand agen pada nama branch baru
  const agentBranchName = formatAgentBranchName(branch);

  const ref = await ghFetch(token, `/repos/${owner}/${repo}/git/ref/heads/${baseBranch}`);
  const sha = ref.object.sha;

  return ghFetch(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${agentBranchName}`, sha }),
    headers: { "Content-Type": "application/json" },
  });
}

export async