/**
 * Helpers for the OpenCode free-tier client fingerprint.
 *
 * Live upstream probes (OpenCode v2, /inference/v1) show that free-tier
 * requests must declare OpenCode's own `read` and `shell` tools with their exact
 * descriptions and parameter schemas; stubbed descriptions, renamed schemas or
 * tool_choice "none" are answered with 403 FreeTierError. Caller tools are sent
 * untouched, except one that already uses an exact fingerprint name with a
 * different definition: it travels under an alias and the response side
 * restores the caller's original name.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Names required by the upstream free-tier gate.
 *
 * Only `read` is actually required: live probes against /inference/v1 show
 * read+shell -> 200, read-only -> 200, shell-only -> 403 FreeTierError, no tools
 * -> 403. Sending the `shell` fingerprint as well only gave the model a tool the
 * client had never declared (agents call their shell tool `bash`), which surfaced
 * to the user as "Tool shell not found". A client's own `shell` now travels
 * untouched and resolves normally.
 */
export const OPENCODE_FINGERPRINT_TOOLS = ["read"];

// Free-tier quota accounting only starts once the prompt carries an
// environment block with real contents. Upstream (v2.0.32, 2026-10-25) answers
// an empty `<env></env>` block, or one without a `Working directory:` line,
// with 429 FreeUsageLimitError — the same error as an exhausted quota. The real
// CLI appends this block, filled from its own cwd, to its system prompt.
//
// `Working directory:` is the marker the gate keys on; the other lines mirror
// the CLI so the block keeps looking genuine if upstream inspects more fields.
const ENV_WORKDIR_MARKER = "Working directory:";

function isGitRepo(cwd) {
  try {
    return fs.existsSync(path.join(cwd, ".git"));
  } catch {
    return false;
  }
}

function buildEnvBlock() {
  let cwd = "/";
  try {
    cwd = process.cwd() || "/";
  } catch { /* cwd removed underneath us, e.g. a deleted workspace dir */ }
  return [
    "<env>",
    `  ${ENV_WORKDIR_MARKER} ${cwd}`,
    `  Workspace root folder: ${cwd}`,
    `  Is directory a git repo: ${isGitRepo(cwd) ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    "</env>",
  ].join("\n");
}

function hasEnvBlock(text) {
  return typeof text === "string"
    && text.includes("<env>")
    && text.includes("</env>")
    && text.includes(ENV_WORKDIR_MARKER);
}

function appendEnvToContent(content, block) {
  if (typeof content === "string") {
    if (hasEnvBlock(content)) return { content, changed: false };
    return { content: `${content.trim() ? `${content}\n\n` : ""}${block}`, changed: true };
  }
  if (!Array.isArray(content)) return { content, changed: false };
  for (const part of content) {
    if (part && typeof part === "object" && typeof part.text === "string") {
      if (hasEnvBlock(part.text)) return { content, changed: false };
      part.text = `${part.text.trim() ? `${part.text}\n\n` : ""}${block}`;
      return { content, changed: true };
    }
  }
  content.push({ type: "text", text: block });
  return { content, changed: true };
}

/**
 * Ensure the request carries an environment block. Upstream's free-tier quota
 * only applies to prompts shaped like an OpenCode session; without a filled
 * block every request is refused with 429 FreeUsageLimitError even when the
 * tool fingerprint is correct.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses bodies (instructions), false for chat/Claude
 * @returns {boolean} true when the body was modified
 */
export function ensureOpencodeEnvBlock(body, flat) {
  if (!body || typeof body !== "object") return false;
  const block = buildEnvBlock();

  if (flat) {
    const current = typeof body.instructions === "string" ? body.instructions : "";
    if (hasEnvBlock(current)) return false;
    body.instructions = current.trim() ? `${current}\n\n${block}` : block;
    return true;
  }

  if (typeof body.system === "string" || Array.isArray(body.system)) {
    const { content, changed } = appendEnvToContent(body.system, block);
    if (changed) body.system = content;
    return changed;
  }

  if (!Array.isArray(body.messages)) return false;

  for (const message of body.messages) {
    if (message?.role !== "system") continue;
    const { content, changed } = appendEnvToContent(message.content, block);
    if (changed) message.content = content;
    return changed;
  }

  body.messages = [{ role: "system", content: block }, ...body.messages];
  return true;
}

// Verbatim from the OpenCode v2.0.26 CLI. Upstream compares description and
// parameters, so do not reword or reformat these.
const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory to read" },
        offset: { type: "integer", minimum: 0, description: "The line or directory entry to start reading from (1-based)" },
        limit: { type: "integer", minimum: 0, description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
};

// Request body -> names renamed for that request. transformRequest() mutates the
// same body object that chatCore passed into the executor, so a WeakMap keeps the
// mapping request-local without putting transport metadata on the wire.
const renamedToolNames = new WeakMap();

/** The fingerprint name when `name` is exactly one; "" otherwise. */
export function fingerprintToolKey(name) {
  const trimmed = String(name ?? "").trim();
  return OPENCODE_FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : "";
}

/** Read a tool name from either flat ({name}) or chat ({function:{name}}) shape. */
function toolNameOf(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
  if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
  const fn = tool.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    return fn.name.trim();
  }
  return "";
}

function chatFunctionOf(tool) {
  const fn = tool?.function;
  return fn && typeof fn === "object" && !Array.isArray(fn) ? fn : null;
}

/** True when `tool` already carries OpenCode's exact definition for `key`. */
function isFingerprintDefinition(tool, key) {
  const def = tool && (chatFunctionOf(tool) || tool);
  const want = FINGERPRINT_TOOL_DEFINITIONS[key];
  return !!def && def.description === want.description
    && JSON.stringify(def.parameters) === JSON.stringify(want.parameters);
}

function withToolName(tool, name) {
  const fn = chatFunctionOf(tool);
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/**
 * Move caller tools off the fingerprint names when their definition differs
 * from OpenCode's, so the exact definitions can be appended without a
 * duplicate name. Everything else, including case variants such as `Read`, is
 * preserved verbatim; upstream accepts them alongside `read`.
 *
 * @param {Array} tools
 * @returns {{ tools: Array, map: Map<string,string> }} map: sent name -> original name
 */
export function concealFingerprintToolNames(tools) {
  const map = new Map();
  if (!Array.isArray(tools) || tools.length === 0) return { tools, map };

  const taken = new Set(tools.map(toolNameOf));
  const seen = new Set();
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      out.push(tool);
      continue;
    }

    const key = fingerprintToolKey(toolNameOf(tool));
    if (!key) {
      out.push(tool);
      continue;
    }

    // Duplicate declarations of one name are rejected upstream; keep the first.
    if (seen.has(key)) continue;
    seen.add(key);

    if (isFingerprintDefinition(tool, key)) {
      out.push(tool);
      continue;
    }

    let alias = `${key}_client`;
    for (let i = 2; taken.has(alias); i++) alias = `${key}_client${i}`;
    taken.add(alias);
    map.set(alias, key);
    out.push(withToolName(tool, alias));
  }
  return { tools: out, map };
}

/**
 * Append OpenCode's definition for each fingerprint tool not already declared.
 *
 * @returns {string[]} names that were appended
 */
export function appendMissingFingerprintTools(tools, flat) {
  const appended = [];
  if (!Array.isArray(tools)) return appended;
  for (const name of OPENCODE_FINGERPRINT_TOOLS) {
    if (tools.some((tool) => fingerprintToolKey(toolNameOf(tool)) === name)) continue;
    const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
    tools.push(flat
      ? { type: "function", name, description, parameters, strict: false }
      : { type: "function", function: { name, description, parameters } });
    appended.push(name);
  }
  return appended;
}

/** Invert a sent -> original rename map. */
function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]));
}

/** Point an explicit tool_choice at the alias of a concealed caller tool. */
export function retargetToolChoice(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const choice = body.tool_choice;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
  const aliases = aliasesByOriginal(map);

  if (typeof choice.name === "string") {
    const alias = aliases.get(choice.name.trim());
    if (alias) body.tool_choice = { ...choice, name: alias };
    return;
  }

  const fn = choice.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
    const alias = aliases.get(fn.name.trim());
    if (alias) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
  }
}

/**
 * Rename prior-turn calls to concealed caller tools as well; otherwise the model
 * reads its own earlier calls as calls to OpenCode's tool of the same name.
 */
export function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const aliases = aliasesByOriginal(map);

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) =>
      item?.type === "function_call" && aliases.has(item.name)
        ? { ...item, name: aliases.get(item.name) }
        : item);
  }

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((msg) => {
      if (!Array.isArray(msg?.tool_calls)) return msg;
      return {
        ...msg,
        tool_calls: msg.tool_calls.map((call) =>
          aliases.has(call?.function?.name)
            ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
            : call),
      };
    });
  }
}

// Without the old "must not be used" descriptions the model does call the
// appended tools (live probe: `read` on "what files are in /etc?"), so tell it
// in the system prompt instead. Upstream does not gate on the prompt text.
// Wording matters: "not available" made the model also refuse the caller's own
// Read/Bash; "placeholders ... use the other tools" kept those working.
function noteUnavailableTools(body, flat, names) {
  const list = names.map((name) => `\`${name}\``).join(" or ");
  const note = names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
  if (flat) {
    body.instructions = typeof body.instructions === "string" && body.instructions.trim()
      ? `${body.instructions}\n\n${note}`
      : note;
    return;
  }
  // OpenAI chat shape only; Claude-shaped bodies carry `system` instead.
  if (!Array.isArray(body.messages) || body.system !== undefined) return;
  const first = body.messages[0];
  if (first?.role === "system" && typeof first.content === "string") {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
  } else {
    body.messages = [{ role: "system", content: note }, ...body.messages];
  }
}

/**
 * Pick the caller tool that can stand in for a fingerprint tool the caller never
 * declared, by matching the fingerprint's required parameters against the caller's
 * schema. Keeps the model off tools the client cannot execute.
 *
 * @returns {string|null} caller tool name, or null when nothing matches
 */
function compatibleClientTool(fingerprintName, clientTools) {
  const required = FINGERPRINT_TOOL_DEFINITIONS[fingerprintName]?.parameters?.required || [];
  if (!required.length) return null;
  let best = null;
  let bestScore = 0;
  for (const tool of clientTools) {
    const def = chatFunctionOf(tool) || tool;
    const props = def?.parameters?.properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) continue;
    const names = Object.keys(props);
    const score = required.filter((key) => names.includes(key)).length;
    if (score > bestScore) {
      bestScore = score;
      best = toolNameOf(tool);
    }
  }
  return bestScore === required.length ? best : null;
}

/**
 * Response-side map. On top of the alias renames it records what to do with a call
 * aimed at a fingerprint tool the caller never declared: rewrite it onto the
 * caller's closest equivalent, or drop it (null) when nothing is equivalent. Both
 * keep an undeclared tool from reaching the client as "Tool ... not found".
 */
function buildResponseMap(aliasMap, appended, clientTools) {
  const responseMap = new Map(aliasMap);
  if (!appended.length || !Array.isArray(clientTools) || !clientTools.length) return responseMap;
  const clientNames = new Set(clientTools.map(toolNameOf).filter(Boolean));
  for (const name of appended) {
    if (clientNames.has(name)) continue;
    responseMap.set(name, compatibleClientTool(name, clientTools));
  }
  return responseMap;
}

/**
 * Full request-side pass: alias conflicting caller tools, append OpenCode's
 * fingerprint definitions, and tell the model the appended ones are off-limits.
 *
 * @param {object} body
 * @param {boolean} flat - true for Responses tools ({name}), false for chat tools
 * @returns {Map<string,string>} map: sent name -> original name
 */
export function applyFingerprintTools(body, flat) {
  if (!body || typeof body !== "object") return new Map();

  const clientTools = Array.isArray(body.tools) ? body.tools.slice() : [];
  const { tools, map } = concealFingerprintToolNames(body.tools);
  body.tools = Array.isArray(tools) ? tools : [];
  const appended = appendMissingFingerprintTools(body.tools, flat);
  retargetToolChoice(body, map);
  aliasHistoryToolCalls(body, map);
  if (appended.length) noteUnavailableTools(body, flat, appended);

  // Responses keeps its explicit auto default. Never default to "none": upstream
  // answers tool_choice "none" with 403 FreeTierError.
  if (!body.tool_choice && flat) body.tool_choice = "auto";

  recordRenamedToolNames(body, buildResponseMap(map, appended, clientTools));
  return map;
}

/** Store the rename map for `body`. */
export function recordRenamedToolNames(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  renamedToolNames.set(body, map);
}

/** Retrieve the rename map for `body`. */
export function takeRenamedToolNames(body) {
  if (!body || typeof body !== "object") return null;
  return renamedToolNames.get(body) || null;
}

// Response side -------------------------------------------------------------

/** Restore caller tool spellings in supported response/event shapes. */
export function restoreToolNames(payload, map) {
  if (!map?.size || !payload) return payload;
  if (Array.isArray(payload)) return payload.map((item) => restoreToolNames(item, map));
  if (typeof payload !== "object") return payload;

  let out = payload;
  const put = (key, value) => {
    if (out === payload) out = { ...payload };
    out[key] = value;
  };

  // Claude streaming content_block_start event.
  if (payload.type === "content_block_start") {
    const block = payload.content_block;
    if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
      put("content_block", { ...block, name: map.get(block.name) });
    }
  }

  // Claude non-streaming message body.
  if (Array.isArray(payload.content)) {
    const blocks = [];
    let contentChanged = false;
    for (const block of payload.content) {
      if (block?.type === "tool_use" && typeof block.name === "string" && map.has(block.name)) {
        const target = map.get(block.name);
        // null = no caller tool can run this; dropping keeps an undeclared tool
        // from reaching the client, which would otherwise fail as "not found".
        if (target == null) { contentChanged = true; continue; }
        blocks.push({ ...block, name: target });
        contentChanged = true;
        continue;
      }
      blocks.push(block);
    }
    if (contentChanged) put("content", blocks);
  }

  // OpenAI Chat Completions, both streaming delta and JSON message shapes.
  if (Array.isArray(payload.choices)) {
    put("choices", payload.choices.map((choice) => {
      let changed = false;
      const next = { ...choice };
      for (const holder of ["delta", "message"]) {
        const value = choice?.[holder];
        if (!value || !Array.isArray(value.tool_calls) || value.tool_calls.length === 0) continue;
        const calls = [];
        for (const call of value.tool_calls) {
          const name = call?.function?.name;
          if (typeof name === "string" && map.has(name)) {
            const target = map.get(name);
            changed = true;
            if (target == null) continue;
            calls.push({ ...call, function: { ...call.function, name: target } });
            continue;
          }
          calls.push(call);
        }
        next[holder] = { ...value, tool_calls: calls };
      }
      return changed ? next : choice;
    }));
  }

  // OpenAI Responses final JSON body.
  if (Array.isArray(payload.output)) {
    const items = [];
    let outputChanged = false;
    for (const item of payload.output) {
      if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
        const target = map.get(item.name);
        if (target == null) { outputChanged = true; continue; }
        items.push({ ...item, name: target });
        outputChanged = true;
        continue;
      }
      items.push(item);
    }
    if (outputChanged) put("output", items);
  }

  // OpenAI Responses SSE events such as response.output_item.added/done.
  const item = payload.item;
  if (item?.type === "function_call" && typeof item.name === "string" && map.has(item.name)) {
    const target = map.get(item.name);
    if (target != null) put("item", { ...item, name: target });
  }

  return out;
}
