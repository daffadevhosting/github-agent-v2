import type { Env } from "./types";

export type PlanName = "free" | "pro" | "team";

export const PLAN_LIMITS: Record<PlanName, { aiRequests: number; indexedRepos: number }> = {
  free: { aiRequests: 100, indexedRepos: 1 },
  pro: { aiRequests: 5000, indexedRepos: 10 },
  team: { aiRequests: 25000, indexedRepos: 100 },
};

export const PLAN_PRICES_IDR: Record<Exclude<PlanName, "free">, number> = {
  pro: 99000,
  team: 299000,
};

export function getPlanPrice(plan: Exclude<PlanName, "free">, env: Env): number {
  return Number(plan === "pro" ? (env.MIDTRANS_PRO_PRICE_IDR || PLAN_PRICES_IDR.pro) : PLAN_PRICES_IDR.team);
}

function encodeBasicAuth(value: string): string {
  return btoa(`${value}:`);
}

export async function createMidtransCheckout(
  env: Env,
  input: { orderId: string; email: string; name: string; plan: Exclude<PlanName, "free"> }
): Promise<{ token?: string; redirectUrl?: string }> {
  if (!env.MIDTRANS_SERVER_KEY) throw new Error("MIDTRANS_SERVER_KEY belum dikonfigurasi.");
  const price = getPlanPrice(input.plan, env);
  if (!Number.isInteger(price) || price <= 0) throw new Error("Harga paket Midtrans tidak valid.");
  const base = env.MIDTRANS_API_BASE || "https://app.sandbox.midtrans.com";
  const response = await fetch(`${base}/snap/v1/transactions`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${encodeBasicAuth(env.MIDTRANS_SERVER_KEY)}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      transaction_details: { order_id: input.orderId, gross_amount: price },
      item_details: [{ id: input.plan, price, quantity: 1, name: `GitHub Agent ${input.plan.toUpperCase()} - 30 hari` }],
      customer_details: { first_name: input.name, email: input.email },
      custom_field1: input.email,
      custom_field2: input.plan,
      callbacks: env.APP_URL ? { finish: `${env.APP_URL.replace(/\/$/, "")}/?billing=success` } : undefined,
    }),
  });
  if (!response.ok) throw new Error(`Midtrans checkout gagal (HTTP ${response.status}).`);
  const data = await response.json() as { token?: string; redirect_url?: string };
  return { token: data.token, redirectUrl: data.redirect_url };
}

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
