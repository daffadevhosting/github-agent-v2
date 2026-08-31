import { tracing } from "cloudflare:workers";
import type { Env, AgentState, UserRecord } from "./types";
import { detectIntent, type IntentResult, AGENT_NAME, AGENT_ID, extractText } from "./intent";
import * as github from "./github";
import { getUserState, saveUserState, logChatMessage, getUserByEmail } from "./db";
import { searchDuckDuckGo } from "./search";

const MODEL = "@cf/openai/gpt-oss-120b";

export async function processAgentMessage(
  env: Env,
  userRecord: UserRecord,
  message: string
): Promise<{ reply: string; state: AgentState }> {
  const trimmed = message.trim();
  const userEmail = userRecord.email;
  // Stable conversation ID per user for Agents dashboard grouping
  const conversationId = userEmail || "anonymous";

  if (!trimmed) {
    const currentState = await getUserState(env.DB, userEmail);
    return { reply: "Pesan tidak boleh kosong.", state: currentState };
  }

  // One invoke_agent span per agent turn (Custom harness)
  return tracing.enterSpan("invoke_agent", async (span) => {
    span.setAttribute("gen_ai.operation.name", "invoke_agent");
    span.setAttribute("gen_ai.agent.name", AGENT_NAME);
    span.setAttribute("gen_ai.agent.id", AGENT_ID);
    span.setAttribute("gen_ai.conversation.id", conversationId);

    await logChatMessage(env.DB, userEmail, "user", trimmed);

    let state = await getUserState(env.DB, userEmail);
    let reply = "";

    try {
      const intent = await detectIntent(env, trimmed, state.currentRepo, conversationId);
      const result = await executeIntent(
        env,
        userRecord,
        intent,
        trimmed,
        state,
        conversationId
      );
      reply = result.reply;
      state = result.state;
    } catch (err: any) {
      reply = `❌ Error: ${err.message || "Terjadi kesalahan saat mengeksekusi perintah."}`;
    }

    await logChatMessage(env.DB, userEmail, "assistant", reply);
    return { reply, state };
  });
}

async function executeIntent(
  env: Env,
  user: UserRecord,
  intent: IntentResult,
  rawText: string,
  state: AgentState,
  conversationId: string = "default-session"
): Promise<{ reply: string; state: AgentState }> {
  let { currentRepo, currentBranch } = state;
  const userEmail = user.email;

  // Cek token GitHub milik user (atau fallback env)
  const ghToken = user.githubToken || env.GITHUB_TOKEN;
  const owner = user.githubUsername || env.GITHUB_OWNER || "me";

  // Branch dinamis: jika belum ada di state, ambil default_branch asli repo dari GitHub
  if (currentRepo && ghToken && !currentBranch) {
    try {
      currentBranch = await github.getDefaultBranch(ghToken, owner, currentRepo);
    } catch {
      currentBranch = "main";
    }
  }
  if (!currentBranch) currentBranch = "main";

  // Perintah yang membutuhkan GitHub Token
  const githubActions = [
    "create_repo", "create_branch", "delete_branch", "create_file", "edit_file",
    "get_file", "delete_file", "list_files", "create_pr", "list_prs", "merge_pr",
    "create_issue", "list_issues", "close_issue", "review_code"
  ];

  if (githubActions.includes(intent.intent) && !ghToken) {
    return {
      reply: `⚠️ **Akun GitHub Belum Terhubung**\n\nUntuk membuat repositori, mengelola file, PR, atau issue di akun GitHub kamu, silakan klik tombol **"Hubungkan GitHub"** di bagian atas atau login menggunakan akun GitHub.\n\n*Kamu tetap bisa bertanya konsep coding, pembuatan skrip, atau bantuan pemrograman lainnya.*`,
      state,
    };
  }

  switch (intent.intent) {
    case "help":
      return { reply: helpText(), state };

    case "create_repo": {
      return tracing.enterSpan("execute_tool", async (span) => {
        span.setAttribute("gen_ai.operation.name", "execute_tool");
        span.setAttribute("gen_ai.tool.name", "create_repo");
        span.setAttribute("gen_ai.agent.name", AGENT_NAME);
        span.setAttribute("gen_ai.agent.id", AGENT_ID);
        span.setAttribute("gen_ai.conversation.id", conversationId);

        const name = intent.params.name;
        if (!name) throw new Error("Nama repositori wajib ditentukan.");
        const isPrivate = !!intent.params.private;
        const res = await github.createRepo(ghToken!, name, isPrivate);
        const newState = await saveUserState(env.DB, userEmail, {
          currentRepo: name,
          currentBranch: "main",
        });
        return {
          reply: `✅ Repositori **[${res.full_name}](${res.html_url})** berhasil dibuat (${isPrivate ? "Private" : "Public"}) di akun **@${owner}**!\nRepo aktif diatur ke: **${name}**`,
          state: newState,
        };
      });
    }

    case "setup_branch": {
      const repo = intent.params.repo || currentRepo;
      const branch = intent.params.branch || currentBranch;
      if (!repo) throw new Error("Tentukan nama repositori terlebih dahulu.");
      const newState = await saveUserState(env.DB, userEmail, { currentRepo: repo, currentBranch: branch });
      return {
        reply: `✅ Repo aktif: **${repo}**, Branch: **${branch}** (Owner: **@${owner}**)`,
        state: newState,
      };
    }

    case "create_branch": {
      return tracing.enterSpan("execute_tool", async (span) => {
        span.setAttribute("gen_ai.operation.name", "execute_tool");
        span.setAttribute("gen_ai.tool.name", "create_branch");
        span.setAttribute("gen_ai.agent.name", AGENT_NAME);
        span.setAttribute("gen_ai.agent.id", AGENT_ID);
        span.setAttribute("gen_ai.conversation.id", conversationId);

        if (!currentRepo) throw new Error("Pilih atau buat repositori terlebih dahulu.");
        const branch = intent.params.branch;
        const from = intent.params.from || currentBranch || "main";
        if (!branch) throw new Error("Nama branch baru wajib ditentukan.");
        await github.createBranch(ghToken!, owner, currentRepo, branch, from);
        const newState = await saveUserState(env.DB, userEmail, { currentBranch: branch });
        return {
          reply: `✅ Branch **${branch}** berhasil dibuat dari **${from}** pada repo **${currentRepo}**.`,
          state: newState,
        };
      });
    }

    case "delete_branch": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const branch = intent.params.branch;
      if (!branch) throw new Error("Nama branch yang ingin dihapus wajib ditentukan.");
      await github.deleteBranch(ghToken!, owner, currentRepo, branch);
      let newState = state;
      if (currentBranch === branch) {
        newState = await saveUserState(env.DB, userEmail, { currentBranch: "main" });
      }
      return {
        reply: `🗑️ Branch **${branch}** berhasil dihapus dari repo **${currentRepo}**.`,
        state: newState,
      };
    }

    case "create_pr": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const title = intent.params.title || "Automated PR from Agent";
      const head = intent.params.head || currentBranch;
      const base = intent.params.base || "main";
      const body = intent.params.body || "Dibuat otomatis oleh GitHub Agent.";
      const pr = await github.createPullRequest(ghToken!, owner, currentRepo, title, head, base, body);
      return {
        reply: `🚀 Pull Request berhasil dibuat:\n**[#${pr.number} ${pr.title}](${pr.html_url})**`,
        state,
      };
    }

    case "list_prs": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const prs = await github.listPullRequests(ghToken!, owner, currentRepo, intent.params.state || "open");
      if (!prs || prs.length === 0) {
        return { reply: `ℹ️ Tidak ada Pull Request di repo **${owner}/${currentRepo}**.`, state };
      }
      const list = prs.map((p: any) => `• [#${p.number}](${p.html_url}) **${p.title}** (${p.state}) oleh @${p.user?.login}`).join("\n");
      return { reply: `📋 **Daftar Pull Request (${owner}/${currentRepo})**:\n\n${list}`, state };
    }

    case "merge_pr": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const number = intent.params.number;
      if (!number) throw new Error("Nomor PR wajib ditentukan (contoh: merge PR #3).");
      const res = await github.mergePullRequest(ghToken!, owner, currentRepo, number, intent.params.message);
      return { reply: `🔀 Pull Request **#${number}** berhasil di-merge: ${res.message || "Sukses"}`, state };
    }

    case "create_issue": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const title = intent.params.title;
      if (!title) throw new Error("Judul issue wajib disertakan.");
      const body = intent.params.body || "Dibuat via GitHub Agent.";
      const issue = await github.createIssue(ghToken!, owner, currentRepo, title, body, intent.params.labels);
      return { reply: `📌 Issue berhasil dibuat: **[#${issue.number} ${issue.title}](${issue.html_url})**`, state };
    }

    case "list_issues": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const issues = await github.listIssues(ghToken!, owner, currentRepo, intent.params.state || "open");
      if (!issues || issues.length === 0) {
        return { reply: `ℹ️ Tidak ada issue di repo **${owner}/${currentRepo}**.`, state };
      }
      const list = issues.map((i: any) => `• [#${i.number}](${i.html_url}) **${i.title}** (${i.state})`).join("\n");
      return { reply: `📋 **Daftar Issue (${owner}/${currentRepo})**:\n\n${list}`, state };
    }

    case "close_issue": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const number = intent.params.number;
      if (!number) throw new Error("Nomor issue wajib ditentukan.");
      await github.closeIssue(ghToken!, owner, currentRepo, number);
      return { reply: `🔒 Issue **#${number}** berhasil ditutup.`, state };
    }

    case "create_file":
    case "edit_file": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const path = intent.params.path;
      const content = intent.params.content || intent.params.code || "";
      const message = intent.params.message || `Update ${path} via GitHub Agent`;
      if (!path) throw new Error("Path file wajib ditentukan (contoh: src/index.js).");
      await github.createOrUpdateFile(ghToken!, owner, currentRepo, path, content, message, currentBranch);
      return { reply: `📝 File **${path}** berhasil disimpan di branch **${currentBranch}** (${owner}/${currentRepo}).`, state };
    }

    case "get_file": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const path = intent.params.path;
      if (!path) throw new Error("Path file wajib ditentukan.");
      const file = await github.getFile(ghToken!, owner, currentRepo, path, currentBranch);
      return {
        reply: `📄 **${path}** (branch: ${currentBranch}):\n\`\`\`\n${file.content || "(file kosong)"}\n\`\`\``,
        state,
      };
    }

    case "list_files": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const files = await github.listFiles(ghToken!, owner, currentRepo, currentBranch);
      if (!files || files.length === 0) {
        return { reply: `ℹ️ Repositori **${owner}/${currentRepo}** (${currentBranch}) masih kosong.`, state };
      }
      const list = files.slice(0, 50).map((f: string) => `• \`${f}\``).join("\n");
      return { reply: `📂 **File dalam repo ${owner}/${currentRepo}** (${currentBranch}):\n\n${list}`, state };
    }

    case "review_code": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const number = intent.params.number ?? intent.params.prNumber;
      let diff = "";
      let reviewTarget = "";

      if (number) {
        const files = await github.getPullRequestFiles(ghToken!, owner, currentRepo, Number(number));
        diff = files
          .map((f: any) => `### ${f.filename}\n\`\`\`\n${(f.patch || "(no patch)").slice(0, 2500)}\n\`\`\``)
          .join("\n\n");
        reviewTarget = `PR #${number}`;
      } else if (intent.params.path) {
        const file = await github.getFile(ghToken!, owner, currentRepo, intent.params.path, currentBranch);
        diff = `### ${intent.params.path}\n\`\`\`\n${(file.content || "").slice(0, 6000)}\n\`\`\``;
        reviewTarget = `file ${intent.params.path}`;
      } else {
        // Ambil isi beberapa file penting agar review bukan hanya daftar nama
        const files = await github.listFiles(ghToken!, owner, currentRepo, currentBranch);
        const priority = files
          .filter((p) => /\.(ts|tsx|js|jsx|py|go|rs|java|php|rb|vue|svelte)$/i.test(p))
          .slice(0, 6);
        const fallback = files.filter((p) => !p.includes("node_modules") && !p.startsWith(".")).slice(0, 4);
        const targets = (priority.length ? priority : fallback).slice(0, 5);

        const chunks: string[] = [];
        for (const p of targets) {
          try {
            const file = await github.getFile(ghToken!, owner, currentRepo, p, currentBranch);
            chunks.push(`### ${p}\n\`\`\`\n${(file.content || "").slice(0, 1800)}\n\`\`\``);
          } catch {
            chunks.push(`### ${p}\n_(gagal dibaca)_`);
          }
        }
        diff = chunks.join("\n\n") || `Daftar file: ${files.slice(0, 30).join(", ")}`;
        reviewTarget = `repo ${owner}/${currentRepo}@${currentBranch}`;
      }

      if (!diff.trim()) {
        return {
          reply: `ℹ️ Tidak ada konten yang bisa direview di **${reviewTarget || currentRepo}**.`,
          state,
        };
      }

      const aiRes: any = await tracing.enterSpan("chat", async (span) => {
        span.setAttribute("gen_ai.operation.name", "chat");
        span.setAttribute("gen_ai.agent.name", AGENT_NAME);
        span.setAttribute("gen_ai.agent.id", AGENT_ID);
        span.setAttribute("gen_ai.conversation.id", conversationId);
        span.setAttribute("gen_ai.request.model", MODEL);

        return env.AI.run(MODEL as any, {
          messages: [
            {
              role: "system",
              content:
                "Kamu adalah Senior Software Engineer. Berikan code review yang konkret dalam Bahasa Indonesia: ringkasan, temuan bug/keamanan, dan saran perbaikan. Gunakan Markdown.",
            },
            {
              role: "user",
              content: `Review ${reviewTarget}:\n\n${diff.slice(0, 12000)}`,
            },
          ],
          max_tokens: 1600,
        });
      });

      const reviewText = extractText(aiRes);
      return {
        reply: `🔍 **Hasil Code Review** (${reviewTarget}):\n\n${reviewText || "Model tidak mengembalikan teks review. Coba ulangi atau sebutkan path file / nomor PR."}`,
        state,
      };
    }

    case "chat":
    default: {
      const prompt = intent.params?.prompt || rawText;

      const needsSearch = shouldSearchWeb(prompt);
      let searchContext = "";

      if (needsSearch) {
        const searchResults = await searchDuckDuckGo(prompt, 3);
        if (searchResults.length > 0) {
          searchContext = `\n\n[Hasil Pencarian Web Terkini (DuckDuckGo)]:\n` +
            searchResults.map((r, i) => `${i + 1}. **${r.title}**: ${r.snippet} (Sumber: ${r.url})`).join("\n");
        }
      }

      const systemPrompt = `Kamu adalah GitHub Agent & Coding Assistant AI yang cerdas, ramah, dan profesional.
- Pengguna saat ini: ${user.name} (@${user.githubUsername || "belum terhubung"}).
- Status aktif saat ini: Repo: "${currentRepo || "(belum dipilih)"}", Branch: "${currentBranch}".
- Jika pengguna menyapa (seperti "Halo", "Hai", "Pagi"), balas dengan ramah dalam bahasa Indonesia dan tawarkan bantuan terkait GitHub/coding.
- Jika pengguna meminta script/kode/tutorial atau pertanyaan teknis, jelaskan secara lengkap menggunakan Markdown dengan format blok kode (\`\`\`bahasa ... \`\`\`).
- Jika ada [Hasil Pencarian Web Terkini], gunakan informasi tersebut untuk memberikan jawaban yang akurat.${searchContext}`;

      try {
        // Metadata-only chat span for general chat model call
        const aiRes: any = await tracing.enterSpan("chat", async (span) => {
          span.setAttribute("gen_ai.operation.name", "chat");
          span.setAttribute("gen_ai.agent.name", AGENT_NAME);
          span.setAttribute("gen_ai.agent.id", AGENT_ID);
          span.setAttribute("gen_ai.conversation.id", conversationId);
          span.setAttribute("gen_ai.request.model", MODEL);

          return env.AI.run(MODEL as any, {
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt },
            ],
            max_tokens: 1400,
          });
        });

        const replyText =
          extractText(aiRes) ||
          "Halo! Ada yang bisa saya bantu terkait repositori GitHub atau pembuatan skrip coding?";
        return { reply: replyText, state };
      } catch (err: any) {
        return {
          reply: `Halo ${user.name}! Saya adalah GitHub Agent. Kamu bisa meminta saya membuat repo, mengelola branch, membuat file, review kode, atau tanya jawab skrip coding.`,
          state,
        };
      }
    }
  }
}

function shouldSearchWeb(text: string): boolean {
  const t = text.toLowerCase();
  const searchKeywords = [
    "cari", "search", "bagaimana cara", "tutorial", "library", "contoh script",
    "dokumentasi", "doc", "versi", "framework", "terbaru", "cara menggunakan", "apa itu"
  ];
  return searchKeywords.some((kw) => t.includes(kw));
}

function helpText(): string {
  return `🤖 **Panduan Lengkap GitHub Agent**

📦 **Repositori**
• \`buat repo namaproject\` — Membuat repo baru di akun GitHub kamu
• \`buat repo secret private\` — Membuat repo private
• \`setup repo namaproject branch main\` — Mengatur repo & branch aktif

🌿 **Branch**
• \`buat branch feature dari main\` — Membuat branch baru
• \`hapus branch feature\` — Menghapus branch

📄 **File & Kode**
• \`buat file index.js\` — Membuat / memperbarui file
• \`baca file config.json\` — Membaca isi file
• \`list files\` — Menampilkan daftar file di repo

🔀 **Pull Request & Review**
• \`buat PR judul Fix Bug dari feature ke main\` — Membuat PR
• \`list PR\` — Menampilkan daftar PR
• \`merge PR #1\` — Melakukan merge PR
• \`review PR #1\` — Code review otomatis dengan AI

📋 **Issue**
• \`buat issue judul Error login\` — Membuat issue baru
• \`list issue\` — Menampilkan daftar issue
• \`tutup issue #2\` — Menutup issue

💬 **Chat Umum & Web Search**
• Tanyakan apa saja seputar coding/skrip pemrograman!`;
}
