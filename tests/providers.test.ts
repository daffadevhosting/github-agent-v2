import { describe, expect, it } from "vitest";
import { decryptProviderKey, encryptProviderKey, resolveProvider } from "../src/providers";

describe("provider security", () => {
  it("encrypts and decrypts BYOK keys without exposing plaintext", async () => {
    const env = { AUTH_SECRET: "a".repeat(32) } as any;
    const encrypted = await encryptProviderKey(env, "sk-test-secret");
    expect(encrypted.encrypted).not.toContain("sk-test-secret");
    await expect(decryptProviderKey(env, encrypted.encrypted, encrypted.iv)).resolves.toBe("sk-test-secret");
  });

  it("requires a key for external providers", () => {
    expect(() => resolveProvider({} as any, "openai")).toThrow(/belum dikonfigurasi/);
  });
});
