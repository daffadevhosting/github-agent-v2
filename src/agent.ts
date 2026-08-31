import type { Env, AgentState } from "./types";
import { detectIntent, type IntentResult } from "./intent";
import * as github from "./github";
import { getUserState, saveUserState, logChatMessage } from "./db";

const MODEL = "@cf/openai/gpt-oss-120b";

export class AgentHandler {
  private env: Env;
  private userEmail: string;
  private state: AgentState;
  private ws: WebSocket;

  constructor(env: Env, userEmail: string, initialState: AgentState, ws: WebSocket) {
    this.env = env;
    this.userEmail = userEmail;
    this.state = initialState;
    this.ws = ws;
  }

  private send(data: any) {
    try {
      this.ws.send(JSON.stringify(data));
    } catch (err) {
      console.warn("Gagal mengirim pesan WebSocket:", err);
    }
  }

  private async updateState(patch: Partial<AgentState>) {
    this.state = { ...this.state, ...patch };
    await saveUserState(this.env.DB, this.userEmail, this.state);
  }

  public async onConnect() {
    this.send({
      type: "status",
      message: `GitHub Agent siap. Repo: ${this.state.currentRepo || "(belum diset)"}, Branch: ${this.state.currentBranch}`,
    });
  }

  public async handleUserMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;

    await logChatMessage(this.env.DB, this.userEmail, "user", trimmed);
    this.send({ type: "thinking", message: "Memproses permintaan..." });

    try {
      const intent = await detectIntent(this.env, trimmed, this.state.currentRepo);
      const result = await this.executeIntent(intent, trimmed);
      
      await logChatMessage(this.env.DB, this.userEmail, "assistant", result);
      this.send({ type: "done", result });
    } catch (err: any) {
      const errorMsg = err.message || "Terjadi kesalahan saat memproses perintah.";
      await logChatMessage(this.env.DB, this.userEmail, "error", errorMsg);
      this.send({ type: "error", message: errorMsg });
    }
  }

  private async executeIntent(intent: IntentResult, rawText: string): Promise<string> {
    const { currentRepo, currentBranch } = this.state;
    const owner = this.env.GITHUB_OWNER;

    switch (intent.intent) {
      case "help":
        return this.helpText();

      case "create_repo": {
        const name = intent.params.name;
        if (!name) throw new Error("Nama repositori wajib ditentukan.");
        const isPrivate = !!intent.params.private;
        const res = await github.createRepo(this.env, name, isPrivate);
        await this.updateState({ currentRepo: name, currentBranch: "main" });
        return `✅ Repositori **${res.full_name}** berhasil dibuat (${isPrivate ? "Private" : "Public"}).\nRepo aktif diatur ke: **${name}**`;
      }

      case "setup_branch": {
        const repo = intent.params.repo || currentRepo;
        const branch = intent.params.branch || currentBranch;
        if (!repo) throw new Error("Tentukan nama repositori terlebih dahulu.");
        await this.updateState({ currentRepo: repo, currentBranch: branch });
        return `✅ Konfigurasi aktif diubah ke Repo: **${repo}**, Branch: **${branch}**`;
      }

      case "create_branch": {
        if (!currentRepo) throw new Error("Pilih atau buat repositori terlebih dahulu.");
        const branch = intent.params.branch;
        const from = intent.params.from || currentBranch || "main";
        if (!branch) throw new Error("Nama branch baru wajib ditentukan.");
        await github.createBranch(this.env, owner, currentRepo, branch, from);
        await this.updateState({ currentBranch: branch });
        return `✅ Branch **${branch}** berhasil dibuat dari **${from}** pada repo **${currentRepo}**.`;
      }

      case "delete_branch": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const branch = intent.params.branch;
        if (!branch) throw new Error("Nama branch yang ingin dihapus wajib ditentukan.");
        await github.deleteBranch(this.env, owner, currentRepo, branch);
        if (this.state.currentBranch === branch) {
          await this.updateState({ currentBranch: "main" });
        }
        return `🗑️ Branch **${branch}** berhasil dihapus dari repo **${currentRepo}**.`;
      }

      case "create_pr": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const title = intent.params.title || "Automated PR from Agent";
        const head = intent.params.head || currentBranch;
        const base = intent.params.base || "main";
        const body = intent.params.body || "Dibuat otomatis oleh GitHub Agent.";
        const pr = await github.createPullRequest(this.env, owner, currentRepo, title, head, base, body);
        return `🚀 Pull Request berhasil dibuat:\n**#${pr.number} ${pr.title}**\n${pr.html_url}`;
      }

      case "list_prs": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const prs = await github.listPullRequests(this.env, owner, currentRepo, intent.params.state || "open");
        if (!prs || prs.length === 0) return `ℹ️ Tidak ada Pull Request aktif di repo **${currentRepo}**.`;
        const list = prs.map((p: any) => `• [#${p.number}](${p.html_url}) **${p.title}** (${p.state}) oleh @${p.user?.login}`).join("\n");
        return `📋 **Daftar Pull Request (${currentRepo})**:\n\n${list}`;
      }

      case "merge_pr": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const number = intent.params.number;
        if (!number) throw new Error("Nomor PR wajib disertakan (contoh: merge PR #3).");
        const res = await github.mergePullRequest(this.env, owner, currentRepo, number, intent.params.message);
        return `🔀 Pull Request **#${number}** berhasil di-merge: ${res.message || "Sukses"}`;
      }

      case "create_issue": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const title = intent.params.title;
        if (!title) throw new Error("Judul issue wajib disertakan.");
        const body = intent.params.body || "Dibuat via GitHub Agent.";
        const issue = await github.createIssue(this.env, owner, currentRepo, title, body, intent.params.labels);
        return `📌 Issue berhasil dibuat: **#${issue.number} ${issue.title}**\n${issue.html_url}`;
      }

      case "list_issues": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const issues = await github.listIssues(this.env, owner, currentRepo, intent.params.state || "open");
        if (!issues || issues.length === 0) return `ℹ️ Tidak ada issue di repo **${currentRepo}**.`;
        const list = issues.map((i: any) => `• [#${i.number}](${i.html_url}) **${i.title}** (${i.state})`).join("\n");
        return `📋 **Daftar Issue (${currentRepo})**:\n\n${list}`;
      }

      case "close_issue": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const number = intent.params.number;
        if (!number) throw new Error("Nomor issue wajib disertakan.");
        await github.closeIssue(this.env, owner, currentRepo, number);
        return `🔒 Issue **#${number}** berhasil ditutup.`;
      }

      case "comment_issue": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const number = intent.params.number;
        const body = intent.params.body;
        if (!number || !body) throw new Error("Nomor issue dan isi komentar wajib diisi.");
        await github.commentIssue(this.env, owner, currentRepo, number, body);
        return `💬 Komentar berhasil ditambahkan ke Issue **#${number}**.`;
      }

      case "create_file":
      case "edit_file": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const path = intent.params.path;
        const content = intent.params.content || intent.params.code || "";
        const message = intent.params.message || `Update ${path} via GitHub Agent`;
        if (!path) throw new Error("Path file wajib ditentukan (contoh: src/index.js).");
        await github.createOrUpdateFile(this.env, owner, currentRepo, path, content, message, currentBranch);
        return `📝 File **${path}** berhasil disimpan di branch **${currentBranch}**.`;
      }

      case "delete_file": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const path = intent.params.path;
        if (!path) throw new Error("Path file yang ingin dihapus wajib disertakan.");
        await github.deleteFile(this.env, owner, currentRepo, path, `Delete ${path}`, currentBranch);
        return `🗑️ File **${path}** berhasil dihapus dari branch **${currentBranch}**.`;
      }

      case "get_file": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const path = intent.params.path;
        if (!path) throw new Error("Path file wajib ditentukan.");
        const file = await github.getFile(this.env, owner, currentRepo, path, currentBranch);
        return `📄 **${path}** (branch: ${currentBranch}):\n\`\`\`\n${file.content || "(file kosong)"}\n\`\`\``;
      }

      case "list_files": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const files = await github.listFiles(this.env, owner, currentRepo, currentBranch);
        if (!files || files.length === 0) return `ℹ️ Repositori **${currentRepo}** (${currentBranch}) masih kosong.`;
        const list = files.slice(0, 50).map((f: string) => `• \`${f}\``).join("\n");
        return `📂 **File dalam repo ${currentRepo}** (${currentBranch}):\n\n${list}`;
      }

      case "review_code": {
        if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
        const number = intent.params.number;
        let diff = "";
        if (number) {
          const files = await github.getPullRequestFiles(this.env, owner, currentRepo, number);
          diff = files.map((f: any) => `File: ${f.filename}\n${f.patch || ""}`).join("\n\n");
        } else {
          const files = await github.listFiles(this.env, owner, currentRepo, currentBranch);
          diff = `File list: ${files.slice(0, 20).join(", ")}`;
        }

        const aiRes: any = await this.env.AI.run(MODEL as any, {
          messages: [
            {
              role: "system",
              content: "Kamu adalah Senior Code Reviewer. Berikan review singkat, padat, dan temukan potensi bug/keamanan dalam bahasa Indonesia.",
            },
            {
              role: "user",
              content: `Tolong review perubahan kode berikut:\n\n${diff.slice(0, 4000)}`,
            },
          ],
          max_tokens: 1000,
        });

        return `🔍 **Hasil Code Review**:\n\n${aiRes?.response || "Review tidak dapat diproses."}`;
      }

      case "chat":
      default: {
        const prompt = intent.params.prompt || rawText;
        const aiRes: any = await this.env.AI.run(MODEL as any, {
          messages: [
            {
              role: "system",
              content: `Kamu adalah asisten GitHub Agent cerdas. Repo aktif: "${currentRepo || "belum diset"}", Branch: "${currentBranch}". Jawab dalam bahasa Indonesia dengan jelas dan ramah.`,
            },
            { role: "user", content: prompt },
          ],
          max_tokens: 800,
        });
        return aiRes?.response || "Maaf, saya tidak dapat memahami permintaan Anda.";
      }
    }
  }

  private helpText(): string {
    return `🤖 **Panduan Perintah GitHub Agent**

📦 **Repositori**
• "buat repo namaproject" — Membuat repo baru (Public)
• "buat repo rahasia private" — Membuat repo baru (Private)
• "setup repo namaproject branch main" — Memilih repo aktif

🌿 **Branch**
• "buat branch feature dari main" — Membuat branch baru
• "hapus branch feature" — Menghapus branch

📄 **File & Kode**
• "buat file index.js" — Membuat/mengedit file di branch aktif
• "baca file config.json" — Membaca isi file
• "hapus file old.js" — Menghapus file
• "list files" — Menampilkan daftar file repositori

🔀 **Pull Request & Review**
• "buat PR judul Fix Bug dari feature ke main" — Membuat PR
• "list PR" — Melihat daftar Pull Request
• "merge PR #1" — Melakukan merge PR
• "review PR #1" — Code review otomatis dengan AI

📋 **Issue**
• "buat issue judul Error saat login" — Membuat issue baru
• "list issue" — Melihat daftar issue aktif
• "tutup issue #2" — Menutup issue`;
  }
}