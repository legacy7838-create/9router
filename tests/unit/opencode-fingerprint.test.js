import { describe, it, expect } from "vitest";
import {
  applyFingerprintTools,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
} from "open-sse/utils/opencodeFingerprint.js";

const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];
const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));
const namesOf = (tools) => tools.map((tool) => tool.name ?? tool.function?.name);

describe("opencodeFingerprint — request side", () => {
  it("appends only the exact read definition and leaves caller tools untouched", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual([...CC_TOOLS, "read"]);
    expect(OPENCODE_FINGERPRINT_TOOLS).toEqual(["read"]);
    expect(map.size).toBe(0);
    // A caller `shell` must stay `shell`: sending the shell fingerprint gave the
    // model a tool agents never declare (they call it `bash`).
    expect(namesOf(body.tools)).not.toContain("shell_client");
    const read = body.tools.find((tool) => tool.name === "read");
    expect(read.description).toMatch(/^Read the contents of a file or directory/);
    expect(read.parameters.required).toEqual(["path"]);
    expect(read.strict).toBe(false);
  });

  it("handles the nested chat shape without dropping .function", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);

    expect(namesOf(body.tools)).toEqual(["Edit", "read"]);
    const read = body.tools.find((tool) => tool.function?.name === "read");
    expect(read.function.parameters.required).toEqual(["path"]);
  });

  it("aliases a caller tool that reuses an exact fingerprint name", () => {
    const body = { tools: flat(["read", "read_client", "Edit"]) };
    const map = applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["read_client2", "read_client", "Edit", "read"]);
    expect(map.get("read_client2")).toBe("read");
  });

  it("keeps a caller tool that already carries OpenCode's exact definition", () => {
    const first = { tools: [] };
    applyFingerprintTools(first, true);
    const official = first.tools.map((tool) => ({ ...tool }));

    const body = { tools: official };
    const map = applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(map.size).toBe(0);
    expect(body.instructions).toBeUndefined();
  });

  it("drops duplicate declarations of one fingerprint name", () => {
    const body = { tools: flat(["read", "read"]) };
    applyFingerprintTools(body, true);
    expect(namesOf(body.tools)).toEqual(["read_client", "read"]);
  });

  it("defaults Responses tool_choice to auto and never to none for chat", () => {
    const responses = { tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.tool_choice).toBe("auto");

    const chatBody = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(namesOf(chatBody.tools)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(chatBody.tool_choice).toBeUndefined();
  });

  it("tells the model the appended tools are placeholders", () => {
    const responses = { instructions: "Be brief.", tools: [] };
    applyFingerprintTools(responses, true);
    expect(responses.instructions).toMatch(/^Be brief\.\n\nDo not call the `read` tool;/);

    const chatBody = { messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] };
    applyFingerprintTools(chatBody, false);
    expect(chatBody.messages).toHaveLength(2);
    expect(chatBody.messages[0].content).toMatch(/^Be brief\.\n\nDo not call the `read` tool;/);

    const noSystem = { messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(noSystem, false);
    expect(noSystem.messages[0]).toEqual({ role: "system", content: expect.stringMatching(/^Do not call/) });

    const claudeShape = { system: "Be brief.", messages: [{ role: "user", content: "hi" }] };
    applyFingerprintTools(claudeShape, false);
    expect(claudeShape.messages).toHaveLength(1);
  });

  it("retargets flat tool_choice that points at an aliased tool", () => {
    const body = { tools: flat(["read"]), tool_choice: { type: "function", name: "read" } };
    applyFingerprintTools(body, true);
    expect(body.tool_choice.name).toBe("read_client");
  });

  it("retargets nested tool_choice that points at an aliased tool", () => {
    const body = {
      tools: chat(["read"]),
      tool_choice: { type: "function", function: { name: "read" } },
    };
    applyFingerprintTools(body, false);
    expect(body.tool_choice.function.name).toBe("read_client");
  });

  it("records the response map against the body for the response side", () => {
    const body = { tools: flat(["read"]) };
    applyFingerprintTools(body, true);
    const recorded = takeRenamedToolNames(body);
    expect(recorded.get("read_client")).toBe("read");
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — never leak an undeclared tool", () => {
  const shellTool = flat(["bash"])[0];

  it("redirects the appended `read` onto the caller's file tool", () => {
    const Read = { type: "function", function: { name: "Read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" } }, required: ["path"] } } };
    const body = { tools: [shellTool, Read] };
    applyFingerprintTools(body, true);

    const recorded = takeRenamedToolNames(body);
    expect(recorded.get("read")).toBe("Read");

    // A call to the fingerprint `read` reaches the client as `Read`.
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "read", arguments: "{}" } }] } }] };
    expect(restoreToolNames(chunk, recorded).choices[0].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("drops the appended `read` when the caller has no file tool at all", () => {
    const body = { tools: [shellTool] };
    applyFingerprintTools(body, true);

    const recorded = takeRenamedToolNames(body);
    expect(recorded.get("read")).toBeNull();

    // Dropped, not forwarded: the client must never see an undeclared tool.
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "read", arguments: "{}" } }] } }] };
    expect(restoreToolNames(chunk, recorded).choices[0].delta.tool_calls).toHaveLength(0);
  });

  it("leaves a caller's own `shell` untouched end to end", () => {
    const shell = { type: "function", function: { name: "shell", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
    const body = { tools: [shell] };
    applyFingerprintTools(body, true);

    expect(namesOf(body.tools)).toEqual(["shell", "read"]);
    const recorded = takeRenamedToolNames(body);
    const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "shell", arguments: "{}" } }] } }] };
    expect(restoreToolNames(chunk, recorded).choices[0].delta.tool_calls[0].function.name).toBe("shell");
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "bash", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("Bash");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Grep");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("matches exact fingerprint names only", () => {
    expect(fingerprintToolKey("read")).toBe("read");
    expect(fingerprintToolKey(" read ")).toBe("read");
    // `shell` is no longer part of the fingerprint, so a caller tool named shell
    // must travel verbatim instead of being concealed.
    expect(fingerprintToolKey("shell")).toBe("");
    expect(fingerprintToolKey("Read")).toBe("");
    expect(fingerprintToolKey("bash")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });
});
