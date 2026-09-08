import type { Env } from "./types";

export type ProviderName = "workers-ai" | "openai" | "anthropic" | "deepseek";

export interface ProviderConfig {
  provider: ProviderName;
  apiKey?: string;
  model?: string;
}

export function resolveProvider(env: Env, requested?: ProviderName): ProviderConfig {
  if (!requested || requested === "workers-ai") {
    return { provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" };
  }
  const key = {
    openai: env.OPENAI_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
    deepseek: env.DEEPSEEK_API_KEY,
  }[requested];
  if (!key) throw new Error(`Provider ${requested} belum dikonfigurasi.`);
  return { provider: requested, apiKey: key };
}
