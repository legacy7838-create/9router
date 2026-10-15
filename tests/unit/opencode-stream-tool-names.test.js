import { describe, it, expect } from "vitest";
import { createPassthroughStreamWithLogger } from "open-sse/utils/stream.js";

// Regression: the OpenCode free-tier fingerprint conceals caller tools that
// collide with `read`/`shell` (sent as `read_client`/`shell_client`). When the
// client and provider share a format the stream runs in PASSTHROUGH mode, which
// forwards the raw `data:` line verbatim unless the chunk needed patching — so a
// restored tool name used to be silently dropped and the client saw the alias.
const enc = new TextEncoder();
const dec = new TextDecoder();

function chunk(delta, extra = {}) {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });
}

async function runPassthrough(chunks, toolNameMap) {
  const stream = createPassthroughStreamWithLogger(
    null, null, "m", null, null, null, null, toolNameMap
  );
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const pumping = (async () => {
    for (const c of chunks) await writer.write(enc.encode(`data: ${c}\n\n`));
    await writer.close();
  })();

  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  await pumping;
  return out;
}

const READ_ALIAS = new Map([["read_client", "read"]]);
const SHELL_ALIAS = new Map([["shell_client", "shell"]]);

describe("passthrough stream — concealed tool name restore", () => {
  it("restores `read_client` on a chunk that needs no other patching", async () => {
    const out = await runPassthrough(
      [chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_client", arguments: '{"path":"/etc/hostname"}' } }] })],
      READ_ALIAS
    );
    expect(out).toContain('"name":"read"');
    expect(out).not.toContain("read_client");
  });

  it("restores `shell_client` on a content-free delta", async () => {
    const out = await runPassthrough(
      [chunk({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "shell_client", arguments: '{"command":"ls"}' } }] })],
      SHELL_ALIAS
    );
    expect(out).toContain('"name":"shell"');
    expect(out).not.toContain("shell_client");
  });

  it("restores every parallel tool call in one delta", async () => {
    const out = await runPassthrough(
      [chunk({ tool_calls: [
        { index: 0, id: "c0", type: "function", function: { name: "read_client", arguments: "{}" } },
        { index: 1, id: "c1", type: "function", function: { name: "shell_client", arguments: "{}" } },
      ] })],
      new Map([["read_client", "read"], ["shell_client", "shell"]])
    );
    expect(out).toContain('"name":"read"');
    expect(out).toContain('"name":"shell"');
    expect(out).not.toContain("_client");
  });

  it("leaves non-alias names untouched", async () => {
    const out = await runPassthrough(
      [chunk({ tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "Edit", arguments: "{}" } }] })],
      READ_ALIAS
    );
    expect(out).toContain('"name":"Edit"');
  });

  it("forwards plain content chunks unchanged when no map is supplied", async () => {
    const out = await runPassthrough([chunk({ content: "hello" })], null);
    expect(out).toContain('"content":"hello"');
  });
});