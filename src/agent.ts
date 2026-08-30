import { Agent } from "agents";
import type { Env } from "./types";
import { detectIntent, type IntentResult } from "./intent";
import * as github from "./github";

interface AgentState {
  currentRepo: string;
  currentBranch: string;
}

const MODEL = "@cf/openai/gpt-oss-120b";

// const MODEL = "@cf/zai-org/glm-5.2";

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

  async onConnect(connection: WebSocket) {
    this.send(connection, {
      type: "status",
      message: `GitHub Agent siap. Repo: ${this.state.currentRepo || "(belum diset)"}, Branch: ${this.state.currentBranch}`,
    });
  }

  async onMessage(connection: WebSocket, data: any) {
    const text: string = typeof data === "string" ? data : data?.message || "";
    if (!text.trim()) return;

    this.send(connection, { type: "thinking", message: "Memproses..." });

    try {
      const intent = await detectIntent(this.env, text, this.state.currentRepo);
      const result = await this.handleIntent(connection, intent, text);
      this.send(connection, { type: "done", result });
    } catch (err: any) {
      this.send(connection, { type: "error", message: err.message || "Unknown error" });
    }
  }

  private send(ws: WebSocket, data: any) {
    ws.send(JSON.stringify(data));
  }

  private async handleIntent(
    ws: WebSocket,
    intent: IntentResult,
    rawText: string
  ): Promise<string> {
    const owner = this.env.GITHUB_OWNER;
    const repo = this.state.currentRepo;
    const branch = intent.params.branch || this.state.currentBranch;

    switch (intent.intent) {
      case "help":
        return this.helpText();

      // Repo
      case "create_repo": {
        const name = intent.params.name;
        const isPrivate = intent.params.isPrivate || false;
        const created = await github.createRepo(this.env, name, isPrivate);
        this.state.currentRepo = name;
        this.setState(this.state);
        return `✅ Repo "${name}" dibuat${isPrivate ? " (private)" : ""}.\nURL: ${created.html_url}`;
      }

      // Branch
      case "create_branch": {
        const br = intent.params.branch;
        const from = intent.params.from || "main";
        await github.createBranch(this.env, owner, repo, br, from);
        this.state.currentBranch = br;
        this.setState(this.state);
        return `✅ Branch "${br}" dibuat dari "${from}" di ${owner}/${repo}.`;
      }

      case "delete_branch": {
        const br = intent.params.branch;
        await github.deleteBranch(this.env, owner, repo, br);
        return `✅ Branch "${br}" dihapus dari ${owner}/${repo}.`;
      }

      case "setup_branch": {
        const from = intent.params.from || "main";
        this.state.currentBranch = from;
        this.setState(this.state);
        return `✅ Active branch diatur ke "${from}".`;
      }

      // Files
      case "list_files": {
        const ref = intent.params.ref || this.state.currentBranch;
        const files = await github.listFiles(this.env, owner, repo, ref);
        const listing = files.map((f: any) => `  ${f.type === "dir" ? "📁" : "📄"} ${f.name}`).join("\n");
        return `📂 ${owner}/${repo} (${ref}):\n${listing}`;
      }

      case "get_file": {
        const path = intent.params.path;
        const ref = intent.params.ref || this.state.currentBranch;
        const { content } = await github.getFile(this.env, owner, repo, path, ref);
        return `📄 ${path} (${ref}):\n\n${content}`;
      }

      case "create_file": {
        const path = intent.params.path;
        const instruction = intent.params.instruction || rawText;
        const fileContent = await this.generateFileContent(path, instruction);
        const commitMsg = await this.generateCommitMessage(path, instruction, "create");
        await github.createOrUpdateFile(this.env, owner, repo, path, fileContent, commitMsg, branch);

        if (intent.params.paths && intent.params.paths.length > 1) {
          for (const p of intent.params.paths) {
            if (p === path) continue;
            const c = await this.generateFileContent(p, instruction);
            const m = await this.generateCommitMessage(p, instruction, "create");
            await github.createOrUpdateFile(this.env, owner, repo, p, c, m, branch);
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
          fileData = await github.getFile(this.env, owner, repo, path, branch);
        } catch {
          fileData = { content: "", sha: undefined };
        }
        const newContent = await this.generateFileEdit(path, fileData.content, instruction);
        const commitMsg = await this.generateCommitMessage(path, instruction, "edit");
        await github.createOrUpdateFile(this.env, owner, repo, path, newContent, commitMsg, branch, fileData.sha);
        return `✅ File "${path}" diperbarui di branch "${branch}".`;
      }

      case "delete_file": {
        const path = intent.params.path;
        const { sha } = await github.getFile(this.env, owner, repo, path, branch);
        await github.deleteFile(this.env, owner, repo, path, sha, branch);
        return `✅ File "${path}" dihapus dari branch "${branch}".`;
      }

      // Pull Requests
      case "create_pr": {
        const title = intent.params.title || rawText.slice(0, 72);
        const head = intent.params.head || this.state.currentBranch;
        const base = intent.params.base || "main";
        const body = intent.params.body || rawText;
        const pr = await github.createPullRequest(this.env, owner, repo, title, head, base, body);
        return `✅ PR #${pr.number} dibuat: "${pr.title}"\n${pr.html_url}\nHead: ${head} → Base: ${base}`;
      }

      case "list_prs": {
        const state = intent.params.state || "open";
        const prs = await github.listPullRequests(this.env, owner, repo, state);
        if (prs.length === 0) return `Tidak ada PR dengan state "${state}" di ${owner}/${repo}.`;
        const listing = prs.map((pr: any) =>
          `  #${pr.number} ${pr.title} — by ${pr.user.login} [${pr.state}]`
        ).join("\n");
        return `🔀 Pull Requests (${state}) di ${owner}/${repo}:\n${listing}`;
      }

      case "merge_pr": {
        const number = intent.params.number;
        const method = intent.params.method || "merge";
        await github.mergePullRequest(this.env, owner, repo, number, method);
        return `✅ PR #${number} di-merge dengan method "${method}" di ${owner}/${repo}.`;
      }

      // Issues
      case "create_issue": {
        const title = intent.params.title || rawText.slice(0, 72);
        const body = intent.params.body || rawText;
        const labels = intent.params.labels || [];
        const issue = await github.createIssue(this.env, owner, repo, title, body, labels);
        return `✅ Issue #${issue.number} dibuat: "${issue.title}"\n${issue.html_url}${labels.length > 0 ? `\nLabels: ${labels.join(", ")}` : ""}`;
      }

      case "list_issues": {
        const state = intent.params.state || "open";
        const issues = await github.listIssues(this.env, owner, repo, state);
        const realIssues = issues.filter((i: any) => !i.pull_request);
        if (realIssues.length === 0) return `Tidak ada issue dengan state "${state}" di ${owner}/${repo}.`;
        const listing = realIssues.map((i: any) =>
          `  #${i.number} ${i.title} — by ${i.user.login} [${i.state}]`
        ).join("\n");
        return `📋 Issues (${state}) di ${owner}/${repo}:\n${listing}`;
      }

      case "close_issue": {
        const number = intent.params.number;
        await github.closeIssue(this.env, owner, repo, number);
        return `✅ Issue #${number} ditutup di ${owner}/${repo}.`;
      }

      case "comment_issue": {
        const number = intent.params.number;
        const body = intent.params.body || rawText;
        const comment = await github.commentIssue(this.env, owner, repo, number, body);
        return `✅ Komentar ditambahkan ke issue #${number}.\n${comment.html_url}`;
      }

      // Code Review
      case "review_code": {
        const prNumber = intent.params.prNumber;
        const filePath = intent.params.path;

        let filesToReview: { filename: string; patch: string }[] = [];

        if (prNumber) {
          const prFiles = await github.getPullRequestFiles(this.env, owner, repo, prNumber);
          filesToReview = prFiles.map((f: any) => ({ filename: f.filename, patch: f.patch || "" }));
        } else if (filePath) {
          const { content } = await github.getFile(this.env, owner, repo, filePath, branch);
          filesToReview = [{ filename: filePath, patch: content }];
        } else {
          return "Tentukan PR number atau file path untuk code review. Contoh: 'review pr #5' atau 'review file app.js'";
        }

        const review = await this.runCodeReview(filesToReview);
        return review;
      }

      // Chat fallback
      case "chat":
      default: {
        const reply = await this.env.AI.run(MODEL, {
          messages: [
            {
              role: "system",
              content: "You are a helpful GitHub automation assistant. Reply in the user's language (Indonesian or English). Be concise.",
            },
            { role: "user", content: rawText },
          ],
          max_tokens: 500,
        });
        return (reply as any)?.response || "Maaf, saya tidak bisa memproses permintaan ini.";
      }
    }
  }

  private async generateFileContent(path: string, instruction: string): Promise<string> {
    const result = await this.env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content: `Generate the COMPLETE content for file "${path}" based on the user's instruction. Output ONLY the file content, no markdown fences, no explanations.`,
        },
        { role: "user", content: instruction },
      ],
      max_tokens: 2000,
    });
    let content = (result as any)?.response || "";
    return content.replace(/^```[a-zA-Z0-9_-]*\n?/m, "").replace(/\n?```$/m, "").trim();
  }

  private async generateFileEdit(path: string, currentContent: string, instruction: string): Promise<string> {
    const result = await this.env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content: `Edit the file "${path}" based on the user's instruction. Output ONLY the complete updated file content, no markdown fences, no explanations.`,
        },
        { role: "user", content: `Current content:\n\n${currentContent}\n\nInstruction: ${instruction}` },
      ],
      max_tokens: 2000,
    });
    let content = (result as any)?.response || currentContent;
    return content.replace(/^```[a-zA-Z0-9_-]*\n?/m, "").replace(/\n?```$/m, "").trim();
  }

  private async generateCommitMessage(path: string, instruction: string, action: string): Promise<string> {
    const result = await this.env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content: "Generate a concise git commit message (max 72 chars). Output ONLY the commit message, no quotes.",
        },
        { role: "user", content: `Action: ${action} file ${path}\nInstruction: ${instruction}` },
      ],
      max_tokens: 72,
    });
    return (result as any)?.response?.trim() || `${action} ${path}`;
  }

  private async runCodeReview(files: { filename: string; patch: string }[]): Promise<string> {
    const fileList = files.map((f) =>
      `--- File: ${f.filename} ---\n${f.patch}`
    ).join("\n\n");

    const result = await this.env.AI.run(MODEL, {
      messages: [
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
      max_tokens: 1500,
    });
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
