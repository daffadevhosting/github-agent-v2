import { Agent } from "agents";
import { tracing } from "cloudflare:workers";
import type { Env } from "./types";
import { detectIntent, type IntentResult } from "./intent";
import * as github from "./github";
import {
  type UserRecord,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  extractBearer,
} from "./users";

interface AgentState {
  currentRepo: string;
  currentBranch: string;
}

const MODEL = "@cf/openai/gpt-oss-120b";
const AGENT_NAME = "github-agent";
const AGENT_ID = "github-agent-default";
const USERS_KEY = "users_v1";

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

export class GitHubAgent extends Agent<Env> {
  get state(): AgentState {
    return (super.state ?? { currentRepo: "", currentBranch: "agent" }) as AgentState;
  }

  private updateState(patch: Partial<AgentState>) {
    this.setState({ ...this.state, ...patch });
  }

  constructor(ctx: any, env: Env) {
    super(ctx, env);
    this.setState({ currentRepo: "", currentBranch: "agent" });
  }

  /**
   * Menangani request masuk ke Durable Object.
   * Memastikan request HTTP langsung dieksekusi di onRequest()
   * dan WebSocket diteruskan ke handler bawaan Agent.
   */
  async fetch(request: Request): Promise<Response> {
    const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (isWebSocket) {
      return super.fetch(request);
    }
    return this.onRequest(request);
  }

  /** HTTP Auth Endpoints */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const is = (suffix: string) =>
      path === suffix || path.endsWith(suffix) || path.includes(suffix);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (is("/auth/register") && request.method === "POST") {
        return this.handleRegister(request);
      }
      if (is("/auth/login") && request.method === "POST") {
        return this.handleLogin(request);
      }
      if (is("/auth/me") && request.method === "GET") {
        return this.handleMe(request);
      }
    } catch (err: any) {
      return json({ error: err.message || "Server error" }, 500);
    }

    return json({ error: "Not found" }, 404);
  }

  private async loadUsers(): Promise<Record<string, UserRecord>> {
    const raw = await (this as any).ctx.storage.get(USERS_KEY);
    return (raw as Record<string, UserRecord>) || {};
  }

  private async saveUsers(users: Record<string, UserRecord>): Promise<void> {
    await (this as any).ctx.storage.put(USERS_KEY, users);
  }

  private async handleRegister(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
      name?: string;
    };
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";
    const name = (body.name || "").trim() || email.split("@")[0];

    if (!email || !email.includes("@")) {
      return json({ error: "Email tidak valid" }, 400);
    }
    if (password.length < 6) {
      return json({ error: "Password minimal 6 karakter" }, 400);
    }

    const users = await this.loadUsers();
    if (users[email]) {
      return json({ error: "Email sudah terdaftar" }, 409);
    }

    const { hash, salt } = await hashPassword(password);
    users[email] = {
      email,
      name,
      passwordHash: hash,
      salt,
      createdAt: Date.now(),
    };
    await this.saveUsers(users);

    const token = await issueToken(this.env, { email, name });
    return json({ token, user: { email, name } }, 201);
  }

  private async handleLogin(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
    };
    const email = (body.email || "").trim().toLowerCase();
    const password = body.password || "";

    if (!email || !password) {
      return json({ error: "Email dan password wajib diisi" }, 400);
    }

    const users = await this.loadUsers();
    const user = users[email];
    if (!user) {
      return json({ error: "Email atau password salah" }, 401);
    }

    const ok = await verifyPassword(password, user.salt, user.passwordHash);
    if (!ok) {
      return json({ error: "Email atau password salah" }, 401);
    }

    const token = await issueToken(this.env, {
      email: user.email,
      name: user.name,
    });
    return json({ token, user: { email: user.email, name: user.name } });
  }

  private async handleMe(request: Request): Promise<Response> {
    const token = extractBearer(request);
    if (!token) return json({ error: "Unauthorized" }, 401);
    const payload = await verifyToken(this.env, token);
    if (!payload) return json({ error: "Token tidak valid" }, 401);
    return json({ user: payload });
  }

  async onConnect(connection: WebSocket) {
    this.send(connection, {
      type: "status",
      message: `GitHub Agent siap. Repo: ${this.state.currentRepo || "(belum diset)"}, Branch: ${this.state.currentBranch}`,
    });
  }

  async onMessage(connection: WebSocket, data: any) {
    const text: string = typeof data === "string" ? data : data?.message || "";
    if (!text.trim()) return;

    const conversationId = "default-session";

    await tracing.enterSpan("invoke_agent", async (span) => {
      span.setAttribute("gen_ai.operation.name", "invoke_agent");
      span.setAttribute("gen_ai.agent.name", AGENT_NAME);
      span.setAttribute("gen_ai.agent.id", AGENT_ID);
      span.setAttribute("gen_ai.conversation.id", conversationId);

      this.send(connection, { type: "thinking", message: "Memproses..." });

      try {
        const intent = await detectIntent(this.env, text, this.state.currentRepo);
        const result = await this.handleIntent(connection, intent, text, conversationId);
        this.send(connection, { type: "done", result });
      } catch (err: any) {
        this.send(connection, { type: "error", message: err.message || "Unknown error" });
        throw err;
      }
    });
  }

  private send(ws: WebSocket, data: any) {
    ws.send(JSON.stringify(data));
  }

  private async tracedAI(
    messages: { role: string; content: string }[],
    options: { max_tokens?: number; temperature?: number } = {},
    conversationId: string = "default-session"
  ): Promise<any> {
    return tracing.enterSpan("chat", async (span) => {
      span.setAttribute("gen_ai.operation.name", "chat");
      span.setAttribute("gen_ai.agent.name", AGENT_NAME);
      span.setAttribute("gen_ai.agent.id", AGENT_ID);
      span.setAttribute("gen_ai.conversation.id", conversationId);
      span.setAttribute("gen_ai.request.model", MODEL);

      const systemMsg = messages.find((m) => m.role === "system");
      if (systemMsg) {
        span.setAttribute("gen_ai.system_instructions", systemMsg.content);
      }
      span.setAttribute("gen_ai.input.messages", JSON.stringify(messages));

      const result = await this.env.AI.run(MODEL, {
        messages,
        max_tokens: options.max_tokens ?? 500,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      });

      const output =
        (result as any)?.response ??
        (result as any)?.result?.response ??
        JSON.stringify(result);
      span.setAttribute("gen_ai.output.messages", JSON.stringify([{ role: "assistant", content: String(output) }]));

      return result;
    });
  }

  private async tracedTool<T>(
    toolName: string,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
    conversationId: string = "default-session"
  ): Promise<T> {
    return tracing.enterSpan("execute_tool", async (span) => {
      span.setAttribute("gen_ai.operation.name", "execute_tool");
      span.setAttribute("gen_ai.agent.name", AGENT_NAME);
      span.setAttribute("gen_ai.agent.id", AGENT_ID);
      span.setAttribute("gen_ai.conversation.id", conversationId);
      span.setAttribute("gen_ai.tool.name", toolName);
      span.setAttribute("gen_ai.tool.call.arguments", JSON.stringify(args));

      const result = await fn();
      try {
        span.setAttribute("gen_ai.tool.call.result", JSON.stringify(result).slice(0, 8000));
      } catch {
        span.setAttribute("gen_ai.tool.call.result", String(result).slice(0, 8000));
      }
      return result;
    });
  }

  private async handleIntent(
    ws: WebSocket,
    intent: IntentResult,
    rawText: string,
    conversationId: string
  ): Promise<string> {
    const owner = this.env.GITHUB_OWNER;
    const repo = this.state.currentRepo;
    const branch = intent.params.branch || this.state.currentBranch;

    switch (intent.intent) {
      case "help":
        return this.helpText();

      case "create_repo": {
        const name = intent.params.name;
        const isPrivate = intent.params.isPrivate || false;
        const created = await this.tracedTool(
          "create_repo",
          { name, isPrivate },
          () => github.createRepo(this.env, name, isPrivate),
          conversationId
        );
        this.state.currentRepo = name;
        this.setState(this.state);
        return `✅ Repo "${name}" dibuat${isPrivate ? " (private)" : ""}.\nURL: ${created.html_url}`;
      }

      case "create_branch": {
        const br = intent.params.branch;
        const from = intent.params.from || "main";
        await this.tracedTool(
          "create_branch",
          { owner, repo, branch: br, from },
          () => github.createBranch(this.env, owner, repo, br, from),
          conversationId
        );
        this.state.currentBranch = br;
        this.setState(this.state);
        return `✅ Branch "${br}" dibuat dari "${from}" di ${owner}/${repo}.`;
      }

      case "delete_branch": {
        const br = intent.params.branch;
        await this.tracedTool(
          "delete_branch",
          { owner, repo, branch: br },
          () => github.deleteBranch(this.env, owner, repo, br),
          conversationId
        );
        return `✅ Branch "${br}" dihapus dari ${owner}/${repo}.`;
      }

      case "setup_branch": {
        const from = intent.params.from || "main";
        this.state.currentBranch = from;
        this.setState(this.state);
        return `✅ Active branch diatur ke "${from}".`;
      }

      case "list_files": {
        const ref = intent.params.ref || this.state.currentBranch;
        const files = await this.tracedTool(
          "list_files",
          { owner, repo, ref },
          () => github.listFiles(this.env, owner, repo, ref),
          conversationId
        );
        const listing = files.map((f: any) => `  ${f.type === "dir" ? "📁" : "📄"} ${f.name}`).join("\n");
        return `📂 ${owner}/${repo} (${ref}):\n${listing}`;
      }

      case "get_file": {
        const path = intent.params.path;
        const ref = intent.params.ref || this.state.currentBranch;
        const { content } = await this.tracedTool(
          "get_file",
          { owner, repo, path, ref },
          () => github.getFile(this.env, owner, repo, path, ref),
          conversationId
        );
        return `📄 ${path} (${ref}):\n\n${content}`;
      }

      case "create_file": {
        const path = intent.params.path;
        const instruction = intent.params.instruction || rawText;
        const fileContent = await this.generateFileContent(path, instruction, conversationId);
        const commitMsg = await this.generateCommitMessage(path, instruction, "create", conversationId);
        await this.tracedTool(
          "create_or_update_file",
          { owner, repo, path, branch },
          () => github.createOrUpdateFile(this.env, owner, repo, path, fileContent, commitMsg, branch),
          conversationId
        );

        if (intent.params.paths && intent.params.paths.length > 1) {
          for (const p of intent.params.paths) {
            if (p === path) continue;
            const c = await this.generateFileContent(p, instruction, conversationId);
            const m = await this.generateCommitMessage(p, instruction, "create", conversationId);
            await this.tracedTool(
              "create_or_update_file",
              { owner, repo, path: p, branch },
              () => github.createOrUpdateFile(this.env, owner, repo, p, c, m, branch),
              conversationId
            );
          }
          return `✅ ${intent.params.paths.length} file dibuat: ${intent.params.paths.join(", ")}`;
        }
        return `✅ File "${path}" dibuat di branch "${branch}".`;
      }

      case "edit_file": {
        const path = intent.params.path;
        const instruction = intent.params.instruction || rawText;
        let fileData;
        try {
          fileData = await this.tracedTool(
            "get_file",
            { owner, repo, path, branch },
            () => github.getFile(this.env, owner, repo, path, branch),
            conversationId
          );
        } catch {
          fileData = { content: "", sha: undefined };
        }
        const newContent = await this.generateFileEdit(path, fileData.content, instruction, conversationId);
        const commitMsg = await this.generateCommitMessage(path, instruction, "edit", conversationId);
        await this.tracedTool(
          "create_or_update_file",
          { owner, repo, path, branch },
          () =>
            github.createOrUpdateFile(
              this.env,
              owner,
              repo,
              path,
              newContent,
              commitMsg,
              branch,
              fileData.sha
            ),
          conversationId
        );
        return `✅ File "${path}" diperbarui di branch "${branch}".`;
      }

      case "delete_file": {
        const path = intent.params.path;
        const { sha } = await this.tracedTool(
          "get_file",
          { owner, repo, path, branch },
          () => github.getFile(this.env, owner, repo, path, branch),
          conversationId
        );
        await this.tracedTool(
          "delete_file",
          { owner, repo, path, branch },
          () => github.deleteFile(this.env, owner, repo, path, sha, branch),
          conversationId
        );
        return `✅ File "${path}" dihapus dari branch "${branch}".`;
      }

      case "create_pr": {
        const title = intent.params.title || rawText.slice(0, 72);
        const head = intent.params.head || this.state.currentBranch;
        const base = intent.params.base || "main";
        const body = intent.params.body || rawText;
        const pr = await this.tracedTool(
          "create_pull_request",
          { owner, repo, title, head, base },
          () => github.createPullRequest(this.env, owner, repo, title, head, base, body),
          conversationId
        );
        return `✅ PR #${pr.number} dibuat: "${pr.title}"\n${pr.html_url}\nHead: ${head} → Base: ${base}`;
      }

      case "list_prs": {
        const state = intent.params.state || "open";
        const prs = await this.tracedTool(
          "list_pull_requests",
          { owner, repo, state },
          () => github.listPullRequests(this.env, owner, repo, state),
          conversationId
        );
        if (prs.length === 0) return `Tidak ada PR dengan state "${state}" di ${owner}/${repo}.`;
        const listing = prs
          .map((pr: any) => `  #${pr.number} ${pr.title} — by ${pr.user.login} [${pr.state}]`)
          .join("\n");
        return `🔀 Pull Requests (${state}) di ${owner}/${repo}:\n${listing}`;
      }

      case "merge_pr": {
        const number = intent.params.number;
        const method = intent.params.method || "merge";
        await this.tracedTool(
          "merge_pull_request",
          { owner, repo, number, method },
          () => github.mergePullRequest(this.env, owner, repo, number, method),
          conversationId
        );
        return `✅ PR #${number} di-merge dengan method "${method}" di ${owner}/${repo}.`;
      }

      case "create_issue": {
        const title = intent.params.title || rawText.slice(0, 72);
        const body = intent.params.body || rawText;
        const labels = intent.params.labels || [];
        const issue = await this.tracedTool(
          "create_issue",
          { owner, repo, title, labels },
          () => github.createIssue(this.env, owner, repo, title, body, labels),
          conversationId
        );
        return `✅ Issue #${issue.number} dibuat: "${issue.title}"\n${issue.html_url}${labels.length > 0 ? `\nLabels: ${labels.join(", ")}` : ""}`;
      }

      case "list_issues": {
        const state = intent.params.state || "open";
        const issues = await this.tracedTool(
          "list_issues",
          { owner, repo, state },
          () => github.listIssues(this.env, owner, repo, state),
          conversationId
        );
        const realIssues = issues.filter((i: any) => !i.pull_request);
        if (realIssues.length === 0) return `Tidak ada issue dengan state "${state}" di ${owner}/${repo}.`;
        const listing = realIssues
          .map((i: any) => `  #${i.number} ${i.title} — by ${i.user.login} [${i.state}]`)
          .join("\n");
        return `📋 Issues (${state}) di ${owner}/${repo}:\n${listing}`;
      }

      case "close_issue": {
        const number = intent.params.number;
        await this.tracedTool(
          "close_issue",
          { owner, repo, number },
          () => github.closeIssue(this.env, owner, repo, number),
          conversationId
        );
        return `✅ Issue #${number} ditutup di ${owner}/${repo}.`;
      }

      case "comment_issue": {
        const number = intent.params.number;
        const body = intent.params.body || rawText;
        const comment = await this.tracedTool(
          "comment_issue",
          { owner, repo, number },
          () => github.commentIssue(this.env, owner, repo, number, body),
          conversationId
        );
        return `✅ Komentar ditambahkan ke issue #${number}.\n${comment.html_url}`;
      }

      case "review_code": {
        const prNumber = intent.params.prNumber;
        const filePath = intent.params.path;

        let filesToReview: { filename: string; patch: string }[] = [];

        if (prNumber) {
          const prFiles = await this.tracedTool(
            "get_pull_request_files",
            { owner, repo, prNumber },
            () => github.getPullRequestFiles(this.env, owner, repo, prNumber),
            conversationId
          );
          filesToReview = prFiles.map((f: any) => ({ filename: f.filename, patch: f.patch || "" }));
        } else if (filePath) {
          const { content } = await this.tracedTool(
            "get_file",
            { owner, repo, path: filePath, branch },
            () => github.getFile(this.env, owner, repo, filePath, branch),
            conversationId
          );
          filesToReview = [{ filename: filePath, patch: content }];
        } else {
          return "Tentukan PR number atau file path untuk code review. Contoh: 'review pr #5' atau 'review file app.js'";
        }

        const review = await this.runCodeReview(filesToReview, conversationId);
        return review;
      }

      case "chat":
      default: {
        const reply = await this.tracedAI(
          [
            {
              role: "system",
              content:
                "You are a helpful GitHub automation assistant. Reply in the user's language (Indonesian or English). Be concise.",
            },
            { role: "user", content: rawText },
          ],
          { max_tokens: 500 },
          conversationId
        );
        return (reply as any)?.response || "Maaf, saya tidak bisa memproses permintaan ini.";
      }
    }
  }

  private async generateFileContent(
    path: string,
    instruction: string,
    conversationId: string
  ): Promise<string> {
    const result = await this.tracedAI(
      [
        {
          role: "system",
          content: `Generate the COMPLETE content for file "${path}" based on the user's instruction. Output ONLY the file content, no markdown fences, no explanations.`,
        },
        { role: "user", content: instruction },
      ],
      { max_tokens: 2000 },
      conversationId
    );
    let content = (result as any)?.response || "";
    return content.replace(/^```[a-zA-Z0-9_-]*\n?/m, "").replace(/\n?```$/m, "").trim();
  }

  private async generateFileEdit(
    path: string,
    currentContent: string,
    instruction: string,
    conversationId: string
  ): Promise<string> {
    const result = await this.tracedAI(
      [
        {
          role: "system",
          content: `Edit the file "${path}" based on the user's instruction. Output ONLY the complete updated file content, no markdown fences, no explanations.`,
        },
        {
          role: "user",
          content: `Current content:\n\n${currentContent}\n\nInstruction: ${instruction}`,
        },
      ],
      { max_tokens: 2000 },
      conversationId
    );
    let content = (result as any)?.response || currentContent;
    return content.replace(/^```[a-zA-Z0-9_-]*\n?/m, "").replace(/\n?```$/m, "").trim();
  }

  private async generateCommitMessage(
    path: string,
    instruction: string,
    action: string,
    conversationId: string
  ): Promise<string> {
    const result = await this.tracedAI(
      [
        {
          role: "system",
          content:
            "Generate a concise git commit message (max 72 chars). Output ONLY the commit message, no quotes.",
        },
        {
          role: "user",
          content: `Action: ${action} file ${path}\nInstruction: ${instruction}`,
        },
      ],
      { max_tokens: 72 },
      conversationId
    );
    return (result as any)?.response?.trim() || `${action} ${path}`;
  }

  private async runCodeReview(
    files: { filename: string; patch: string }[],
    conversationId: string
  ): Promise<string> {
    const fileList = files
      .map((f) => `--- File: ${f.filename} ---\n${f.patch}`)
      .join("\n\n");

    const result = await this.tracedAI(
      [
        {
          role: "system",
          content: `You are a senior and profesional code reviewer. Review the following code changes and provide:
1. Summary of changes
2. Potential bugs or issues
3. Security concerns
4. Suggestions for improvement
5. Overall assessment (approve / needs changes)

Be concise and specific. Reply in the user's language (Indonesian or English).`,
        },
        { role: "user", content: fileList },
      ],
      { max_tokens: 1500 },
      conversationId
    );
    return `🔍 **Code Review**\n\n${(result as any)?.response || "Review tidak tersedia."}`;
  }

  private helpText(): string {
    return `🤖 GitHub Automation Agent v2

📦 Repo
  • "buat repo myproject" — Buat repo baru
  • "buat repo secret private" — Buat repo private

🌿 Branch
  • "buat branch feature dari main" — Buat branch baru
  • "hapus branch old-feature" — Hapus branch
  • "switch branch develop" — Ganti active branch

📄 File
  • "buat file index.html" — Buat file baru
  • "edit file app.js, tambahkan validasi" — Edit file
  • "baca file config.json" — Lihat isi file
  • "hapus file old-script.js" — Hapus file
  • "list files" — Tampilkan struktur direktori

🔀 Pull Request
  • "buat PR judul Fix bug dari feature ke main" — Buat PR
  • "list PR" — Tampilkan semua PR
  • "merge PR #5" — Merge PR

📋 Issue
  • "buat issue judul Login error" — Buat issue
  • "list issue" — Tampilkan semua issue
  • "tutup issue #3" — Tutup issue
  • "komentar issue #5: sudah diperbaiki" — Komentar issue

🔍 Code Review
  • "review PR #5" — Review kode di PR
  • "review file app.js" — Review file tertentu

🌐 Web Project
  • "buat landing page" — Scaffold HTML/CSS/JS

💬 Lainnya
  • "help" — Tampilkan bantuan ini
  • Pertanyaan bebas — Chat dengan AI

Context:
  • Repo: ${this.state.currentRepo || "(belum diset)"}
  • Branch: ${this.state.currentBranch}`;
  }
}