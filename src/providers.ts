import type { Env } from "./types";

export type ProviderName = "workers-ai" | "openai" | "anthropic" | "deepseek";
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ProviderConfig {
  provider: ProviderName;
  apiKey?: string;
  model: string;
}

const DEFAULT_MODELS: Record<ProviderName, string> = {
  "workers-ai": "@cf/openai/gpt-oss-120b",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-sonnet-latest",
  deepseek: "deepseek-chat",
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const secret = env.BYOK_ENCRYPTION_KEY || env.AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("BYOK_ENCRYPTION_KEY atau AUTH_SECRET minimal 32 karakter wajib dikonfigurasi.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptProviderKey(env: Env, value: string): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(value)
  );
  return { encrypted: bytesToBase64(new Uint8Array(encrypted)), iv: bytesToBase64(iv) };
}

export async function decryptProviderKey(env: Env, encrypted: string, iv: string): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv).buffer as ArrayBuffer },
    await encryptionKey(env),
    base64ToBytes(encrypted).buffer as ArrayBuffer
  );
  return new TextDecoder().decode(plain);
}

export function resolveProvider(env: Env, requested?: ProviderName, userApiKey?: string): ProviderConfig {
  const provider = requested || "workers-ai";
  if (provider === "workers-ai") return { provider, model: DEFAULT_MODELS[provider] };
  const apiKey = userApiKey || {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
  }[provider];
  if (!apiKey) throw new Error(`Provider ${provider} belum dikonfigurasi.`);
  return { provider, apiKey, model: DEFAULT_MODELS[provider] };
}

export async function runProvider(
  env: Env,
  config: ProviderConfig,
  messages: ChatMessage[],
  maxTokens: number
): Promise<string> {
  if (config.provider === "workers-ai") {
    const result = await env.AI.run(config.model as any, { messages, max_tokens: maxTokens }) as any;
    return String(result?.response || result?.result?.response || result?.text || "");
  }

  const endpoint = config.provider === "anthropic"
    ? "https://api.anthropic.com/v1/messages"
    : config.provider === "deepseek"
      ? "https://api.deepseek.com/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    max_tokens: maxTokens,
  };
  if (config.provider === "anthropic") {
    delete headers.Authorization;
    headers["x-api-key"] = config.apiKey!;
    headers["anthropic-version"] = "2023-06-01";
    body.system = messages.find((message) => message.role === "system")?.content;
    body.messages = messages.filter((message) => message.role !== "system");
  }
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Provider ${config.provider} mengembalikan HTTP ${response.status}.`);
  const data = await response.json() as any;
  if (config.provider === "anthropic") return String(data.content?.[0]?.text || "");
  return String(data.choices?.[0]?.message?.content || "");
}
