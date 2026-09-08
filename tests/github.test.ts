import { describe, expect, it } from "vitest";
import { formatAgentBranchName } from "../src/github";

describe("GitHub branch naming", () => {
  it("normalizes agent-created branches consistently", () => {
    expect(formatAgentBranchName("Feature/Login Fix")).toBe("github-agent/feature/login-fix");
    expect(formatAgentBranchName("github-agent/fix-ci")).toBe("github-agent/fix-ci");
  });
});
