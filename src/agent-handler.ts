import type { Env, AgentState } from "./types";
import { detectIntent, type IntentResult } from "./intent";
import * as github from "./github";
import { getUserState, saveUserState, logChatMessage } from "./db";
import { searchDuckDuckGo } from "./search";

const MODEL = "@cf/openai/gpt-oss-120b";

export async function processAgentMessage(
  env: Env,
  userEmail: string,
  message: string
): Promise<{ reply: string; state: AgentState }> {
  const trimmed = message.trim();
  if (!trimmed) {
    const currentState = await getUserState(env.DB, userEmail);
    return { reply: "Pesan tidak boleh kosong.", state: currentState };
  }

  await logChatMessage(env.DB, userEmail, "user", trimmed);

  let state = await getUserState(env.DB, userEmail);
  let reply = "";

  try {
    // 1. Deteksi apakah intent perintah GitHub atau percakapan umum
    const intent = await detectIntent(env, trimmed, state.currentRepo);
    const result = await executeIntent(env, userEmail, intent, trimmed, state);
    reply = result.reply;
    state = result.state;
  } catch (err: any) {
    reply = `❌ Error: ${err.message || "Terjadi kesalahan saat mengeksekusi perintah."}`;
  }

  await logChatMessage(env.DB, userEmail, "assistant", reply);
  return { reply, state };
}

async function executeIntent(
  env: Env,
  userEmail: string,
  intent: IntentResult,
  rawText: string,
  state: AgentState
): Promise<{ reply: string; state: AgentState }> {
  let { currentRepo, currentBranch } = state;
  const owner = env.GITHUB_OWNER;

  switch (intent.intent) {
    case "help":
      return { reply: helpText(), state };

    case "create_repo": {
      const name = intent.params.name;
      if (!name) throw new Error("Nama repositori wajib ditentukan.");
      const isPrivate = !!intent.params.private;
      const res = await github.createRepo(env, name, isPrivate);
      const newState = await saveUserState(env.DB, userEmail, { currentRepo: name, currentBranch: "main" });
      return {
        reply: `✅ Repositori **${res.full_name}** berhasil dibuat (${isPrivate ? "Private" : "Public"}).\nRepo aktif diatur ke: **${name}**`,
        state: newState,
      };
    }

    case "setup_branch": {
      const repo = intent.params.repo || currentRepo;
      const branch = intent.params.branch || currentBranch;
      if (!repo) throw new Error("Tentukan nama repositori terlebih dahulu.");
      const newState = await saveUserState(env.DB, userEmail, { currentRepo: repo, currentBranch: branch });
      return {
        reply: `✅ Repo aktif diatur ke: **${repo}**, Branch: **${branch}**`,
        state: newState,
      };
    }

    case "create_branch": {
      if (!currentRepo) throw new Error("Pilih atau buat repositori terlebih dahulu.");
      const branch = intent.params.branch;
      const from = intent.params.from || currentBranch || "main";
      if (!branch) throw new Error("Nama branch baru wajib ditentukan.");
      await github.createBranch(env, owner, currentRepo, branch, from);
      const newState = await saveUserState(env.DB, userEmail, { currentBranch: branch });
      return {
        reply: `✅ Branch **${branch}** berhasil dibuat dari **${from}** pada repo **${currentRepo}**.`,
        state: newState,
      };
    }

    case "delete_branch": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const branch = intent.params.branch;
      if (!branch) throw new Error("Nama branch yang ingin dihapus wajib ditentukan.");
      await github.deleteBranch(env, owner, currentRepo, branch);
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
      const pr = await github.createPullRequest(env, owner, currentRepo, title, head, base, body);
      return {
        reply: `🚀 Pull Request berhasil dibuat:\n**[#${pr.number} ${pr.title}](${pr.html_url})**`,
        state,
      };
    }

    case "list_prs": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const prs = await github.listPullRequests(env, owner, currentRepo, intent.params.state || "open");
      if (!prs || prs.length === 0) {
        return { reply: `ℹ️ Tidak ada Pull Request di repo **${currentRepo}**.`, state };
      }
      const list = prs.map((p: any) => `• [#${p.number}](${p.html_url}) **${p.title}** (${p.state}) oleh @${p.user?.login}`).join("\n");
      return { reply: `📋 **Daftar Pull Request (${currentRepo})**:\n\n${list}`, state };
    }

    case "merge_pr": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const number = intent.params.number;
      if (!number) throw new Error("Nomor PR wajib ditentukan (contoh: merge PR #3).");
      const res = await github.mergePullRequest(env, owner, currentRepo, number, intent.params.message);
      return { reply: `🔀 Pull Request **#${number}** berhasil di-merge: ${res.message || "Sukses"}`, state };
    }

    case "create_issue": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const title = intent.params.title;
      if (!title) throw new Error("Judul issue wajib disertakan.");
      const body = intent.params.body || "Dibuat via GitHub Agent.";
      const issue = await github.createIssue(env, owner, currentRepo, title, body, intent.params.labels);
      return { reply: `📌 Issue berhasil dibuat: **[#${issue.number} ${issue.title}](${issue.html_url})**`, state };
    }

    case "list_issues": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const issues = await github.listIssues(env, owner, currentRepo, intent.params.state || "open");
      if (!issues || issues.length === 0) {
        return { reply: `ℹ️ Tidak ada issue di repo **${currentRepo}**.`, state };
      }
      const list = issues.map((i: any) => `• [#${i.number}](${i.html_url}) **${i.title}** (${i.state})`).join("\n");
      return { reply: `📋 **Daftar Issue (${currentRepo})**:\n\n${list}`, state };
    }

    case "close_issue": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const number = intent.params.number;
      if (!number) throw new Error("Nomor issue wajib ditentukan.");
      await github.closeIssue(env, owner, currentRepo, number);
      return { reply: `🔒 Issue **#${number}** berhasil ditutup.`, state };
    }

    case "create_file":
    case "edit_file": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const path = intent.params.path;
      const content = intent.params.content || intent.params.code || "";
      const message = intent.params.message || `Update ${path} via GitHub Agent`;
      if (!path) throw new Error("Path file wajib ditentukan (contoh: src/index.js).");
      await github.createOrUpdateFile(env, owner, currentRepo, path, content, message, currentBranch);
      return { reply: `📝 File **${path}** berhasil disimpan di branch **${currentBranch}**.`, state };
    }

    case "get_file": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const path = intent.params.path;
      if (!path) throw new Error("Path file wajib ditentukan.");
      const file = await github.getFile(env, owner, currentRepo, path, currentBranch);
      return {
        reply: `📄 **${path}** (branch: ${currentBranch}):\n\`\`\`\n${file.content || "(file kosong)"}\n\`\`\``,
        state,
      };
    }

    case "list_files": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const files = await github.listFiles(env, owner, currentRepo, currentBranch);
      if (!files || files.length === 0) {
        return { reply: `ℹ️ Repositori **${currentRepo}** (${currentBranch}) masih kosong.`, state };
      }
      const list = files.slice(0, 50).map((f: string) => `• \`${f}\``).join("\n");
      return { reply: `📂 **File dalam repo ${currentRepo}** (${currentBranch}):\n\n${list}`, state };
    }

    case "review_code": {
      if (!currentRepo) throw new Error("Pilih repositori terlebih dahulu.");
      const number = intent.params.number;
      let diff = "";
      if (number) {
        const files = await github.getPullRequestFiles(env, owner, currentRepo, number);
        diff = files.map((f: any) => `File: ${f.filename}\n${f.patch || ""}`).join("\n\n");
      } else {
        const files = await github.listFiles(env, owner, currentRepo, currentBranch);
        diff = `File list: ${files.slice(0, 20).join(", ")}`;
      }

      const aiRes: any = await env.AI.run(MODEL as any, {
        messages: [
          {
            role: "system",
            content: "Kamu adalah Senior Software Engineer. Berikan review kode ringkas, temukan celah keamanan, dan berikan saran perbaikan dalam Markdown.",
          },
          { role: "user", content: `Tolong review kode berikut:\n\n${diff.slice(0, 4000)}` },
        ],
        max_tokens: 1200,
      });

      return { reply: `🔍 **Hasil Code Review**:\n\n${aiRes?.response || "Review tidak dapat diproses."}`, state };
    }

    case "chat":
    default: {
      const prompt = intent.params?.prompt || rawText;

      // 2. Deteksi apakah perlu pencarian web DuckDuckGo
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
- Status aktif saat ini: Repo: "${currentRepo || "(belum dipilih)"}", Branch: "${currentBranch}".
- Jika pengguna menyapa (seperti "Halo", "Hai", "Pagi"), balas dengan ramah dalam bahasa Indonesia dan tawarkan bantuan terkait GitHub/coding.
- Jika pengguna meminta script/kode/tutorial atau pertanyaan teknis, jelaskan secara lengkap menggunakan Markdown dengan format blok kode (\`\`\`bahasa ... \`\`\`).
- Jika ada [Hasil Pencarian Web Terkini], gunakan informasi tersebut untuk memberikan jawaban yang akurat.${searchContext}`;

      try {
        const aiRes: any = await env.AI.run(MODEL as any, {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          max_tokens: 1400,
        });

        const replyText = aiRes?.response || "Halo! Ada yang bisa saya bantu terkait repositori GitHub atau pembuatan skrip coding?";
        return { reply: replyText, state };
      } catch (err: any) {
        return {
          reply: `Halo! Saya adalah GitHub Agent. Kamu bisa meminta saya membuat repo, mengelola branch, membuat file, review kode, atau tanya jawab skrip coding. (Detail: ${err.message || "Model AI busy"})`,
          state,
        };
      }
    }
  }
}

/**
 * Mendeteksi apakah pesan membutuhkan pencarian DuckDuckGo
 */
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
• \`buat repo namaproject\` — Membuat repo baru (Public)
• \`buat repo secret private\` — Membuat repo baru (Private)
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
• Kamu bisa langsung bertanya konsep coding apa saja atau minta dibuatkan script. Agen akan otomatis mencari referensi lewat DuckDuckGo jika diperlukan!`;
}