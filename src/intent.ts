import { tracing } from "cloudflare:workers";
import type { Env } from "./types";

export const AGENT_NAME = "github-agent";
export const AGENT_ID = "github-agent-default";

export type IntentType =
  | "create_repo"
  | "create_branch"
  | "delete_branch"
  | "edit_file"
  | "create_file"
  | "delete_file"
  | "list_files"
  | "get_file"
  | "setup_branch"
  | "create_pr"
  | "list_prs"
  | "merge_pr"
  | "create_issue"
  | "list_issues"
  | "close_issue"
  | "comment_issue"
  | "review_code"
  | "help"
  | "chat";

export interface IntentResult {
  intent: IntentType;
  params: Record<string, any>;
  confidence?: "rule" | "ai" | "fallback";
}

const MODEL = "@cf/openai/gpt-oss-120b";

// const MODEL = "@cf/zai-org/glm-5.2";

function extractText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  const res = result as Record<string, any>;
  if (typeof res.response === "string") return res.response;
  if (res.result && typeof res.result.response === "string") return res.result.response;
  if (Array.isArray(res.choices) && res.choices[0]?.message?.content) {
    const content = res.choices[0].message.content;
    if (typeof content === "string") return content;
  }
  try {
    return typeof result === "object" ? JSON.stringify(result) : String(result);
  } catch {
    return "";
  }
}

function cleanCode(text: string): string {
  return text
    .replace(/^```[a-zA-Z0-9_-]*\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();
}

function extractJsonFromText(text: string): Record<string, any> | null {
  if (!text) return null;
  const cleaned = cleanCode(text);
  try {
    return JSON.parse(cleaned);
  } catch {}
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {}
  }
  return null;
}

const FILE_PATH_REGEX =
  /(?:['"`])?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+|Dockerfile|Makefile|LICENSE|\.gitignore|\.env[a-zA-Z0-9._-]*)(?:['"`])?/i;
const MULTI_FILE_REGEX =
  /(?:['"`])?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+|Dockerfile|Makefile|LICENSE|\.gitignore|\.env[a-zA-Z0-9._-]*)(?:['"`])?/gi;

function extractAllPaths(text: string): string[] {
  const paths: string[] = [];
  const re = new RegExp(MULTI_FILE_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1] && !paths.includes(match[1])) paths.push(match[1]);
  }
  return paths;
}

function extractNumber(text: string): number | undefined {
  const m = text.match(/#?(\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

function ruleDetectIntent(userMessage: string): IntentResult | null {
  const t = userMessage.trim();
  const lower = t.toLowerCase();

  if (
    /^(help|bantuan|menu|perintah|\?|info|panduan|cara (pakai|menggunakan))$/i.test(lower) ||
    lower.includes("daftar perintah") ||
    lower.includes("bisa apa saja")
  ) {
    return { intent: "help", params: {}, confidence: "rule" };
  }

  // PR: create
  if (/(?:buat|bikin|create|open|submit)\s+(?:pr|pull\s*request|pullrequest)/i.test(lower)) {
    const titleMatch = t.match(/(?:judul|title|bernama|dengan\s+judul)\s+["']?([^"'\n]+)["']?/i);
    const headMatch = t.match(/(?:dari|from|head|branch)\s+["']?([a-zA-Z0-9_\-./]+)["']?/i);
    const baseMatch = t.match(/(?:ke|to|base|into)\s+["']?([a-zA-Z0-9_\-./]+)["']?/i);
    return {
      intent: "create_pr",
      params: {
        title: titleMatch ? titleMatch[1] : undefined,
        head: headMatch ? headMatch[1] : undefined,
        base: baseMatch ? baseMatch[1] : "main",
        body: t,
      },
      confidence: "rule",
    };
  }

  // PR: list
  if (/(?:tampilkan|lihat|list|daftar|cek|show)\s+(?:semua\s+)?(?:pr|pull\s*request)/i.test(lower) || /^(prs?|pulls?)$/i.test(lower)) {
    const stateMatch = lower.match(/(open|closed|merged|all)/);
    return {
      intent: "list_prs",
      params: { state: stateMatch ? stateMatch[1] : "open" },
      confidence: "rule",
    };
  }

  // PR: merge
  if (/(?:merge|gabungkan|approve)\s+(?:pr|pull\s*request)?\s*#?(\d+)/i.test(lower) || /(?:merge|gabungkan)\s+#?(\d+)/i.test(lower)) {
    const num = extractNumber(t);
    const methodMatch = lower.match(/(squash|rebase|merge)/);
    return {
      intent: "merge_pr",
      params: { number: num, method: methodMatch ? methodMatch[1] : "merge" },
      confidence: "rule",
    };
  }

  // Issue: create
  if (/(?:buat|bikin|create|open|submit)\s+(?:issue|bug|ticket|laporan)/i.test(lower)) {
    const titleMatch = t.match(/(?:judul|title|bernama)\s+["']?([^"'\n]+)["']?/i);
    const labelsMatch = t.match(/(?:label|tags?)\s+([a-zA-Z0-9_,\s]+)/i);
    return {
      intent: "create_issue",
      params: {
        title: titleMatch ? titleMatch[1] : undefined,
        body: t,
        labels: labelsMatch ? labelsMatch[1].split(/[,_\s]+/).filter(Boolean) : [],
      },
      confidence: "rule",
    };
  }

  // Issue: list
  if (/(?:tampilkan|lihat|list|daftar|cek|show)\s+(?:semua\s+)?(?:issue|bug|ticket)/i.test(lower) || /^(issues?)$/i.test(lower)) {
    const stateMatch = lower.match(/(open|closed|all)/);
    return {
      intent: "list_issues",
      params: { state: stateMatch ? stateMatch[1] : "open" },
      confidence: "rule",
    };
  }

  // Issue: close
  if (/(?:tutup|close)\s+(?:issue|bug|ticket)?\s*#?(\d+)/i.test(lower) || /(?:tutup|close)\s+#?(\d+)/i.test(lower)) {
    const num = extractNumber(t);
    return {
      intent: "close_issue",
      params: { number: num },
      confidence: "rule",
    };
  }

  // Issue: comment
  if (/(?:komentar|comment)\s+(?:issue|pr|pull\s*request)?\s*#?(\d+)/i.test(lower)) {
    const num = extractNumber(t);
    return {
      intent: "comment_issue",
      params: { number: num, body: t },
      confidence: "rule",
    };
  }

  // Code review
  if (/(?:review|review\s+kode|periksa\s+kode|cek\s+kode|code\s+review)\s+/i.test(lower) || /^code\s*review$/i.test(lower)) {
    const prMatch = t.match(/(?:pr|pull\s*request)\s*#?(\d+)/i);
    const fileMatch = t.match(FILE_PATH_REGEX);
    return {
      intent: "review_code",
      params: {
        prNumber: prMatch ? parseInt(prMatch[1], 10) : undefined,
        path: fileMatch ? fileMatch[1] : undefined,
      },
      confidence: "rule",
    };
  }

  // Scaffold web project
  if (
    /(?:buat|bikin|scaffold|generate)\s+(?:proyek|project|aplikasi|landing\s*page|website|web)\s+/i.test(lower) ||
    /(?:buat|bikin)\s+(?:landing\s*page|website)/i.test(lower)
  ) {
    if (lower.includes("html") || lower.includes("css") || lower.includes("js") || lower.includes("lengkap") || lower.includes("web") || lower.includes("landing")) {
      return {
        intent: "create_file",
        params: {
          paths: ["index.html", "style.css", "script.js"],
          path: "index.html",
          instruction: t,
          isWebProject: true,
        },
        confidence: "rule",
      };
    }
  }

  // List files
  if (
    /^(ls|dir|tree)$/i.test(lower) ||
    /(?:tampilkan|lihat|list|daftar|cek|show)\s+(?:semua\s+)?(?:file|berkas|folder|struktur|direktori)/i.test(lower) ||
    /ada\s+file\s+apa\s+(saja|aja)/i.test(lower)
  ) {
    const branchMatch = t.match(/(?:di|pada|from|branch)\s+([a-zA-Z0-9_\-./]+)/i);
    return {
      intent: "list_files",
      params: { ref: branchMatch ? branchMatch[1] : undefined },
      confidence: "rule",
    };
  }

  // Create repo
  let m = t.match(
    /(?:buat|bikin|create|tambah)\s+(?:repo(?:sitory)?|proyek|project)(?:\s+baru)?(?:\s+(?:bernama|nama|named|dengan nama|judul))?\s+[:"']?([a-zA-Z0-9_\-]+)["']?/i
  );
  if (m && !/web|html|css|landing/i.test(lower)) {
    const isPrivate = /private|pribadi|rahasia/i.test(lower);
    return {
      intent: "create_repo",
      params: { name: m[1], isPrivate },
      confidence: "rule",
    };
  }

  // Create branch
  m = t.match(
    /(?:buat|bikin|create|new)\s+branch(?:\s+baru)?\s+[:"']?([a-zA-Z0-9_\-./]+)["']?(?:\s+(?:dari|from)\s+(?:branch\s+)?[:"']?([a-zA-Z0-9_\-./]+)["']?)?/i
  );
  if (m) {
    return {
      intent: "create_branch",
      params: { branch: m[1], from: m[2] || undefined },
      confidence: "rule",
    };
  }

  // Delete branch
  m = t.match(/(?:hapus|delete|remove|rm)\s+branch\s+([a-zA-Z0-9_\-./]+)/i);
  if (m) {
    return { intent: "delete_branch", params: { branch: m[1] }, confidence: "rule" };
  }

  // Rewrite file
  if (/(?:hapus|delete|remove).+(?:kemudian|lalu|terus|then|and).+(?:buat|bikin|create|tulis|ganti)/i.test(lower)) {
    const paths = extractAllPaths(t);
    if (paths.length > 0) {
      return {
        intent: "edit_file",
        params: { path: paths[0], instruction: "Tulis ulang file ini dari awal. " + t },
        confidence: "rule",
      };
    }
  }

  // Delete file
  if (/(?:hapus|delete|remove|rm)\s+(?:file\s+|berkas\s+)?/i.test(lower)) {
    const fileMatch = t.match(FILE_PATH_REGEX);
    if (fileMatch) {
      return { intent: "delete_file", params: { path: fileMatch[1] }, confidence: "rule" };
    }
  }

  // Create file
  if (
    /(?:buat|bikin|create|tambah(?:kan)?|generate)\s+(?:file|berkas|dokumen|script)\s+/i.test(lower) ||
    /(?:buat|bikin|create)\s+[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+/i.test(lower)
  ) {
    const paths = extractAllPaths(t);
    if (paths.length > 0) {
      return {
        intent: "create_file",
        params: {
          path: paths[0],
          paths: paths.length > 1 ? paths : undefined,
          instruction: t,
        },
        confidence: "rule",
      };
    }
  }

  // Sync / multi-file
  if (/(?:sesuaikan|sinkron|sync|samakan|padankan|hubungkan)\s+/i.test(lower)) {
    const paths = extractAllPaths(t);
    if (paths.length >= 1) {
      return {
        intent: "edit_file",
        params: { path: paths[0], paths, instruction: t },
        confidence: "rule",
      };
    }
  }

  // Edit file
  if (/(?:edit|ubah|update|ganti|perbarui|modify|refactor|fix|perbaiki)\s+/i.test(lower)) {
    const fileMatch = t.match(FILE_PATH_REGEX);
    if (fileMatch) {
      return {
        intent: "edit_file",
        params: { path: fileMatch[1], instruction: t },
        confidence: "rule",
      };
    }
  }

  // Get file
  if (/(?:buka|baca|tampilkan|lihat|open|read|view|cat|isi\s+dari)\s+/i.test(lower)) {
    const fileMatch = t.match(FILE_PATH_REGEX);
    if (fileMatch) {
      return { intent: "get_file", params: { path: fileMatch[1] }, confidence: "rule" };
    }
  }

  // Setup branch
  if (/(?:setup|persiapkan|siapkan|checkout|pindah|switch)\s+branch/i.test(lower)) {
    const branchMatch = t.match(/(?:ke|menuju|to|dari|from)\s+([a-zA-Z0-9_\-./]+)/i);
    return {
      intent: "setup_branch",
      params: { from: branchMatch ? branchMatch[1] : "main" },
      confidence: "rule",
    };
  }

  return null;
}

export async function detectIntent(
  env: Env,
  userMessage: string,
  context?: string,
  conversationId: string = "default-session"
): Promise<IntentResult> {
  const trimmedMessage = userMessage.trim();
  if (!trimmedMessage) {
    return { intent: "chat", params: { message: "" }, confidence: "fallback" };
  }

  const ruled = ruleDetectIntent(trimmedMessage);
  if (ruled) return ruled;

  const systemPrompt = `You are a GitHub automation AI agent. Analyze the user's intent in Indonesian/English and output ONLY valid JSON.

Available Intents:
- "create_repo"   -> { "name": string, "isPrivate": boolean }
- "create_branch" -> { "branch": string, "from"?: string }
- "delete_branch" -> { "branch": string }
- "create_file"   -> { "path": string, "paths"?: string[], "instruction": string, "branch"?: string }
- "edit_file"     -> { "path": string, "instruction": string, "branch"?: string }
- "delete_file"   -> { "path": string, "branch"?: string }
- "get_file"      -> { "path": string, "ref"?: string }
- "list_files"    -> { "ref"?: string }
- "setup_branch"  -> { "from"?: string }
- "create_pr"     -> { "title": string, "head": string, "base": string, "body": string }
- "list_prs"      -> { "state": "open"|"closed"|"all" }
- "merge_pr"      -> { "number": number, "method": "merge"|"squash"|"rebase" }
- "create_issue"  -> { "title": string, "body": string, "labels"?: string[] }
- "list_issues"   -> { "state": "open"|"closed"|"all" }
- "close_issue"   -> { "number": number }
- "comment_issue" -> { "number": number, "body": string }
- "review_code"   -> { "prNumber"?: number, "path"?: string }
- "help"          -> {}
- "chat"          -> { "message": string }

When user asks for a web project / landing page, use create_file with paths ["index.html","style.css","script.js"].

Context Repo: "${context || "default/repo"}"

OUTPUT ONLY RAW JSON:`;

  try {
    // Metadata-only chat span for intent detection (no payload content)
    const result: unknown = await tracing.enterSpan("chat", async (span) => {
      span.setAttribute("gen_ai.operation.name", "chat");
      span.setAttribute("gen_ai.agent.name", AGENT_NAME);
      span.setAttribute("gen_ai.agent.id", AGENT_ID);
      span.setAttribute("gen_ai.conversation.id", conversationId);
      span.setAttribute("gen_ai.request.model", MODEL);

      const aiResult = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: trimmedMessage },
        ],
        max_tokens: 400,
        temperature: 0.1,
      });

      return aiResult;
    });

    const rawText = extractText(result);
    const parsed = extractJsonFromText(rawText);

    if (parsed && typeof parsed.intent === "string") {
      return {
        intent: parsed.intent as IntentType,
        params: parsed.params || {},
        confidence: "ai",
      };
    }
  } catch (err) {
    console.error("AI Intent Detection failed:", err);
  }

  return {
    intent: "chat",
    params: { message: trimmedMessage },
    confidence: "fallback",
  };
}
