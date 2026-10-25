import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureOpencodeEnvBlock } from "../../open-sse/utils/opencodeFingerprint.js";

// Live probes: upstream accepts the request only when the system prompt carries
// a filled <env>...</env> block with a `Working directory:` line. Without one
// even a correct tool fingerprint is answered with 429 FreeUsageLimitError.
const CWD = process.cwd();
const ENV_BLOCK = [
  "<env>",
  `  Working directory: ${CWD}`,
  `  Workspace root folder: ${CWD}`,
  `  Is directory a git repo: ${fs.existsSync(path.join(CWD, ".git")) ? "yes" : "no"}`,
  `  Platform: ${process.platform}`,
  "</env>",
].join("\n");

describe("ensureOpencodeEnvBlock", () => {
  it("prepends a system message when the chat body has none", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(ensureOpencodeEnvBlock(body, false)).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: ENV_BLOCK });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("appends the block to an existing string system message once", () => {
    const body = { messages: [{ role: "system", content: "You are helpful." }, { role: "user", content: "hi" }] };
    expect(ensureOpencodeEnvBlock(body, false)).toBe(true);
    expect(body.messages[0].content).toBe(`You are helpful.\n\n${ENV_BLOCK}`);
    expect(ensureOpencodeEnvBlock(body, false)).toBe(false);
    expect(body.messages[0].content).toBe(`You are helpful.\n\n${ENV_BLOCK}`);
  });

  it("appends inside array-shaped system content", () => {
    const body = { messages: [{ role: "system", content: [{ type: "text", text: "rules" }] }] };
    expect(ensureOpencodeEnvBlock(body, false)).toBe(true);
    expect(body.messages[0].content[0].text).toBe(`rules\n\n${ENV_BLOCK}`);
  });

  it("handles Claude-shaped bodies via the system field", () => {
    const body = { system: "be brief", messages: [{ role: "user", content: "hi" }] };
    expect(ensureOpencodeEnvBlock(body, false)).toBe(true);
    expect(body.system).toBe(`be brief\n\n${ENV_BLOCK}`);
  });

  it("handles Responses bodies via instructions", () => {
    const body = { instructions: "be brief", input: [] };
    expect(ensureOpencodeEnvBlock(body, true)).toBe(true);
    expect(body.instructions).toBe(`be brief\n\n${ENV_BLOCK}`);
    const empty = { input: [] };
    expect(ensureOpencodeEnvBlock(empty, true)).toBe(true);
    expect(empty.instructions).toBe(ENV_BLOCK);
  });

  it("leaves a filled env block untouched", () => {
    const body = { messages: [{ role: "system", content: `<env>\n  Working directory: /tmp\n</env>` }] };
    expect(ensureOpencodeEnvBlock(body, false)).toBe(false);
  });

  it("completes a partial env block", () => {
    const body = { messages: [{ role: "system", content: "<env>" }] };
    expect(ensureOpencodeEnvBlock(body, false)).toBe(true);
    expect(body.messages[0].content).toContain("</env>");
    expect(body.messages[0].content).toContain("Working directory:");
  });

  it("adds a filled block when an empty env block is present", () => {
    const body = { messages: [{ role: "system", content: "<env>\n</env>" }] };
    expect(ensureOpencodeEnvBlock(body, false)).toBe(true);
    expect(body.messages[0].content).toContain("Working directory:");
  });
});
