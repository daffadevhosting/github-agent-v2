import type { Env } from "./types";

export type PlanName = "free" | "pro" | "team";

export const PLAN_LIMITS: Record<PlanName, { aiRequests: number; indexedRepos: number }> = {
  free: { aiRequests: 100, indexedRepos: 1 },
  pro: { aiRequests: 5000, indexedRepos: 10 },
  team: { aiRequests: 25000, indexedRepos: 100 },
};

export async function verifyMidtransSignature(
  env: Env,
  orderId: string,
  statusCode: string,
  grossAmount: string,
  signature: string
): Promise<boolean> {
  if (!env.MIDTRANS_SERVER_KEY) {
    throw new Error("MIDTRANS_SERVER_KEY belum dikonfigurasi.");
  }
  const payload = `${orderId}${statusCode}${grossAmount}${env.MIDTRANS_SERVER_KEY}`;
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}
