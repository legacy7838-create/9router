import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dbg } from "./debugLog.js";

/**
 * OpenCode free-tier transport.
 *
 * Upstream refuses requests that do not look like they were made by the real
 * OpenCode CLI. Body shape (tool fingerprint + <env> block) is handled by the
 * executor; the TLS ClientHello is not: Node/undici, curl, Python and relay
 * services all get 429 FreeUsageLimitError, while Bun's BoringSSL handshake
 * (what the CLI is built on) is accepted. Requests therefore leave through a
 * lazily spawned Bun sidecar when the server itself runs under Node.
 */

const TOKEN = crypto.randomBytes(24).toString("hex");
const START_TIMEOUT_MS = 10_000;
const SIDECAR_SOURCE = String.raw`
const token = process.env.OC_SIDECAR_TOKEN || "";
// Exit when the host process dies, even if it was SIGKILLed and never ran its
// exit handlers (otherwise the sidecar survives as an orphan).
const parentPid = Number(process.env.OC_SIDECAR_PARENT || 0);
if (parentPid) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      process.exit(0);
    }
  }, 5000).unref();
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.headers.get("x-oc-token") !== token) return new Response("forbidden", { status: 403 });
    if (new URL(req.url).pathname !== "/fetch") return new Response("not found", { status: 404 });
    let payload;
    try {
      payload = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!payload || typeof payload.url !== "string") return new Response("missing url", { status: 400 });
    const init = {
      method: payload.method || "POST",
      headers: payload.headers || {},
      body: payload.body ?? undefined,
      redirect: "manual",
    };
    if (payload.proxy) init.proxy = payload.proxy;
    if (req.signal) init.signal = req.signal;
    try {
      const upstream = await fetch(payload.url, init);
      const headers = new Headers(upstream.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      return new Response(
        JSON.stringify({ error: String(error && error.message ? error.message : error) }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  },
});
console.log("READY " + server.port);
`;

let sidecar = null;
let starting = null;
let sidecarScript = null;

export function isBunRuntime() {
  return typeof globalThis.Bun !== "undefined";
}

function findBunBinary() {
  if (process.env.OC_BUN_PATH) return process.env.OC_BUN_PATH;
  const names = process.platform === "win32" ? ["bun.exe", "bun"] : ["bun"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* keep looking */ }
    }
  }
  const home = os.homedir();
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  const bunInstallDir = process.env.BUN_INSTALL || path.join(home, ".bun");
  for (const candidate of [
    path.join(bunInstallDir, "bin", exe),
    path.join(home, ".bun", "bin", exe),
    path.join("C:\\Program Files\\Bun", exe),
    `/usr/local/bin/${exe}`,
    `/usr/bin/${exe}`,
  ]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function writeSidecarScript() {
  if (sidecarScript) return sidecarScript;
  const file = path.join(os.tmpdir(), `9router-oc-bun-${process.pid}.mjs`);
  fs.writeFileSync(file, SIDECAR_SOURCE, "utf8");
  sidecarScript = file;
  return file;
}

function spawnSidecar() {
  const bun = findBunBinary();
  if (!bun) {
    throw new Error(
      "OpenCode free tier requires the Bun runtime for its TLS fingerprint; install bun or set OC_BUN_PATH",
    );
  }
  const child = spawn(bun, [writeSidecarScript()], {
    env: { ...process.env, OC_SIDECAR_TOKEN: TOKEN, OC_SIDECAR_PARENT: String(process.pid) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      fn(value);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/READY\s+(\d+)/);
      if (match) finish(resolve, { child, port: Number(match[1]) });
    };
    const onStderr = (chunk) => {
      const text = chunk.toString().trim();
      if (text) dbg("FETCH", `OPENCODE bun sidecar: ${text}`);
    };
    const onExit = (code) => {
      finish(reject, new Error(`OpenCode bun sidecar exited with code ${code}`));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error("OpenCode bun sidecar failed to start in time"));
    }, START_TIMEOUT_MS);
    if (timer.unref) timer.unref();

    child.stdout.on("data", onData);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function ensureSidecar() {
  if (sidecar && sidecar.child.exitCode === null && !sidecar.child.killed) return sidecar;
  if (starting) return starting;
  starting = spawnSidecar()
    .then((entry) => {
      const stop = () => {
        try { entry.child.kill(); } catch { /* already gone */ }
      };
      entry.child.once("exit", () => {
        process.off("exit", stop);
        if (sidecar?.child === entry.child) sidecar = null;
      });
      process.once("exit", stop);
      // Never keep the host process (CLI run, tests) alive for the sidecar.
      entry.child.unref?.();
      entry.child.stdout?.resume();
      entry.child.stderr?.resume();
      entry.child.stdout?.unref?.();
      entry.child.stderr?.unref?.();
      sidecar = entry;
      dbg("FETCH", `OPENCODE bun sidecar ready on 127.0.0.1:${entry.port}`);
      return entry;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  return { ...headers };
}

/**
 * Fetch an upstream URL through Bun's TLS stack.
 *
 * @param {string} url
 * @param {RequestInit & { body?: string }} init
 * @param {string|null} proxyUrl - explicit proxy; Bun also honours proxy env vars
 */
export async function opencodeBunFetch(url, init = {}, proxyUrl = null) {
  if (isBunRuntime()) {
    const options = { ...init };
    if (proxyUrl) options.proxy = proxyUrl;
    return fetch(url, options);
  }

  const entry = await ensureSidecar();
  const res = await fetch(`http://127.0.0.1:${entry.port}/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-oc-token": TOKEN },
    body: JSON.stringify({
      url: String(url),
      method: init.method || "POST",
      headers: normalizeHeaders(init.headers),
      body: typeof init.body === "string" ? init.body : null,
      proxy: proxyUrl || null,
    }),
    signal: init.signal,
  });
  return res;
}

function bypassByNoProxy(targetUrl, noProxy) {
  const value = String(noProxy || "").trim();
  if (!value) return false;
  let hostname;
  try {
    hostname = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return value.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean).some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/** Resolve an explicit per-connection proxy for the Bun transport. */
export function resolveBunProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;
  const raw = String(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl ?? "").trim();
  if (!raw) return null;
  if (bypassByNoProxy(targetUrl, proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy)) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}
