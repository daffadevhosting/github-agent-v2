import { describe, expect, it } from "vitest";
import { issueToken } from "../src/users";

describe("JWT configuration", () => {
  it("rejects missing or weak authentication secrets", async () => {
    await expect(
      issueToken({ AUTH_SECRET: "short" } as any, { email: "user@example.com", name: "User" })
    ).rejects.toThrow("AUTH_SECRET wajib dikonfigurasi");
  });
});
