import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
    const pathname = new URL(req.url).pathname;
    if (pathname === "/health") return new Response("ok");
    if (pathname !== "/fetch") return new Response("not found", { status: 404 });
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

// Resolving the Bun binary walks PATH plus a few install dirs; cache both hits
// and misses so a host without Bun does not rescan on every request.
const BUN_HIT_TTL_MS = 5 * 60 * 1000;
const BUN_MISS_TTL_MS = 60 * 1000;
let bunCache = null;

function scanBunBinary() {
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

function findBunBinary() {
  if (process.env.OC_BUN_PATH) return process.env.OC_BUN_PATH;
  const now = Date.now();
  if (bunCache && now < bunCache.expires) return bunCache.path;
  const found = scanBunBinary();
  bunCache = { path: found, expires: now + (found ? BUN_HIT_TTL_MS : BUN_MISS_TTL_MS) };
  return found;
}

function writeSidecarScript() {
  if (sidecarScript) return sidecarScript;
  const file = path.join(os.tmpdir(), `9router-oc-bun-${process.pid}.mjs`);
  fs.writeFileSync(file, SIDECAR_SOURCE, "utf8");
  sidecarScript = file;
  process.once("exit", () => {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  });
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

function recycleSidecar(entry) {
  if (!entry) return;
  if (sidecar?.child === entry.child) sidecar = null;
  try { entry.child.kill(); } catch { /* already gone */ }
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

// Long-running hosts need the lane to stay self-healing: expired proxy
// cooldowns must not linger, and a sidecar that stops answering must be
// replaced instead of failing every later request. The sweep is cheap and runs
// every 15 minutes by default (OC_MAINTENANCE_INTERVAL_MS overrides it).
const MAINTENANCE_INTERVAL_MS = Number(process.env.OC_MAINTENANCE_INTERVAL_MS) || 15 * 60 * 1000;
let maintenanceStarted = false;
let maintenanceTimer = null;

function sidecarHealthy(entry) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: entry.port, path: "/health", method: "GET", headers: { "x-oc-token": TOKEN }, timeout: 2_000 },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === 200));
        res.on("error", () => resolve(false));
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * Periodic housekeeping; safe to call at any time.
 * @param {number} [now] injectable clock for tests
 */
export async function runOpencodeMaintenance(now = Date.now()) {
  let pruned = 0;
  for (const [key, until] of PROXY_COOLDOWN_UNTIL) {
    if (until <= now) {
      PROXY_COOLDOWN_UNTIL.delete(key);
      PROXY_LAST_ERROR.delete(key);
      pruned++;
    }
  }
  if (pruned) dbg("FETCH", `OPENCODE maintenance pruned ${pruned} expired egress state entries`);

  if (!sidecar) return;
  if (sidecar.child.exitCode !== null || sidecar.child.killed) {
    sidecar = null;
    return;
  }
  const entry = sidecar;
  if (await sidecarHealthy(entry)) return;
  // Drop the wedged sidecar so the next request respawns it. Streams started
  // before the sweep keep their own socket until the process exits.
  recycleSidecar(entry);
  dbg("FETCH", "OPENCODE bun sidecar unhealthy; recycling");
}

// Self-scheduling with jitter so several router processes sharing one egress
// pool do not sweep the same proxies at the same instant.
function scheduleMaintenance() {
  const jitter = 0.9 + Math.random() * 0.2;
  maintenanceTimer = setTimeout(async () => {
    maintenanceTimer = null;
    try {
      await runOpencodeMaintenance();
    } catch { /* housekeeping is best-effort */ }
    scheduleMaintenance();
  }, Math.max(1_000, Math.round(MAINTENANCE_INTERVAL_MS * jitter)));
  maintenanceTimer.unref?.();
}

function ensureMaintenance() {
  if (maintenanceStarted) return;
  maintenanceStarted = true;
  scheduleMaintenance();
}

/**
 * Fetch an upstream URL through Bun's TLS stack.
 *
 * @param {string} url
 * @param {RequestInit & { body?: string }} init
 * @param {string|null} proxyUrl - explicit proxy; Bun also honours proxy env vars
 */
export async function opencodeBunFetch(url, init = {}, proxyUrl = null) {
  ensureMaintenance();
  if (isBunRuntime()) {
    const options = { ...init };
    if (proxyUrl) options.proxy = proxyUrl;
    return fetch(url, options);
  }

  const entry = await ensureSidecar();
  try {
    return await fetch(`http://127.0.0.1:${entry.port}/fetch`, {
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
  } catch (error) {
    // A failed call to the local sidecar means the sidecar itself is gone or
    // wedged (upstream failures come back as 502 JSON, not a throw). Drop it so
    // the next attempt respawns instead of hammering a dead port.
    if (init.signal?.aborted || error?.name === "AbortError") throw error;
    dbg("FETCH", `OPENCODE sidecar request failed (${error.message}); recycling`);
    recycleSidecar(entry);
    throw error;
  }
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

// Rotating egress pool. Upstream meters the free tier per source IP, so one
// exhausted IP must not fail the request while other proxies still have quota.
// OC_PROXY_LIST (comma/space separated) wins; otherwise warpgen's generated
// list is used when present. The pool only applies while the connection's
// proxy option is on: with it off this lane must leave directly, even if a
// stale pool is still sitting on disk.
const PROXY_COOLDOWN_UNTIL = new Map();
const PROXY_LAST_ERROR = new Map();

function normalizeProxyEntry(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

// Pool files are rewritten by the generator, so cache the parsed list keyed by
// mtime/size: a stat per request is cheap, while parsing a large list on every
// request is not. An unreadable file keeps the last good pool instead of
// silently collapsing to "no proxy".
const PROXY_FILE_CACHE = new Map();
const PROXY_FILE_CACHE_MAX = 8;

function readProxyFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    PROXY_FILE_CACHE.delete(file);
    return [];
  }
  const cached = PROXY_FILE_CACHE.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.entries;
  try {
    const entries = fs.readFileSync(file, "utf8").split(/[\s,]+/).map(normalizeProxyEntry).filter(Boolean);
    if (!PROXY_FILE_CACHE.has(file) && PROXY_FILE_CACHE.size >= PROXY_FILE_CACHE_MAX) {
      PROXY_FILE_CACHE.delete(PROXY_FILE_CACHE.keys().next().value);
    }
    PROXY_FILE_CACHE.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
    return entries;
  } catch {
    return cached ? cached.entries : [];
  }
}

function readProxyList() {
  const entries = [];
  if (process.env.OC_PROXY_LIST) entries.push(...process.env.OC_PROXY_LIST.split(/[\s,]+/));
  entries.push(...readProxyFile(process.env.OC_PROXY_FILE || "/var/lib/warpgen/proxies.txt"));
  return entries.map(normalizeProxyEntry).filter(Boolean);
}

function proxyRequested(proxyOptions) {
  return proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
}

/**
 * Proxy candidates for one request, in attempt order.
 * @returns {(string|null)[]} `null` represents a direct connection
 */
export function resolveBunProxyCandidates(targetUrl, proxyOptions) {
  // The connection's proxy option is the contract: off means direct, and a
  // leftover OC_PROXY_LIST / warpgen file must not silently route through an
  // egress the operator just disabled.
  if (!proxyRequested(proxyOptions)) return [null];

  const configuredRaw = String(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl ?? "").trim();
  if (configuredRaw && bypassByNoProxy(targetUrl, proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy)) {
    return [null];
  }

  const configured = resolveBunProxyUrl(targetUrl, proxyOptions);
  const pool = [...new Set(readProxyList())].filter((proxy) => proxy !== configured);
  if (configured) return [configured, ...pool];
  return pool.length ? pool : [null];
}

function retryAfterMs(headers) {
  const value = headers?.get?.("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function proxyKey(proxyUrl) {
  return proxyUrl || "direct";
}

// Egress state is keyed per proxy and bounded: a pool file that keeps churning
// through new addresses must not grow these maps without limit in a
// long-running process. Re-inserting refreshes the entry's recency.
const PROXY_STATE_MAX = 500;

function rememberProxyState(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > PROXY_STATE_MAX) map.delete(map.keys().next().value);
}

function transientRetryAttempts() {
  const raw = Number(process.env.OC_TRANSIENT_RETRY_ATTEMPTS);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(5, Math.floor(raw)) : 2;
}

function transientRetryDelayMs(round) {
  const raw = Number(process.env.OC_TRANSIENT_RETRY_DELAY_MS);
  const base = Number.isFinite(raw) && raw >= 0 ? raw : 600;
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(base * 2 ** round * jitter);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("OpenCode request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason || new Error("OpenCode request aborted"));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function formatResetWindow(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.ceil((total % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// The free tier caps requests per IP per day; surface when it comes back so
// clients and the dashboard show a real reset instead of a bare 429.
function exhaustedResponse(status, headers, text) {
  const seconds = Number(headers.get("retry-after"));
  if (!Number.isFinite(seconds) || seconds <= 0) return new Response(text, { status, headers });

  const resetsAt = new Date(Date.now() + seconds * 1000);
  let body = text;
  try {
    const json = JSON.parse(text);
    const message = json?.error?.message;
    if (typeof message === "string" && !message.includes("resets in")) {
      json.error.message = `${message} (free quota resets in ${formatResetWindow(seconds)}, at ${resetsAt.toISOString().slice(0, 16).replace("T", " ")} UTC)`;
      body = JSON.stringify(json);
    }
  } catch { /* non-JSON upstream error keeps its body */ }

  const outHeaders = new Headers(headers);
  outHeaders.set("x-9router-reset", resetsAt.toISOString());
  return new Response(body, { status, headers: outHeaders });
}

/**
 * Fetch, walking the proxy list on 429 responses (and on connection errors).
 * A 429 that carries `retry-after` means the egress is out of free quota, so it
 * is parked for that window and later requests skip it. A 429 without
 * `retry-after` is a transient burst throttle: it moves to the next egress, is
 * retried a couple of times with jittered backoff, and never parks anything, so
 * a burst neither fails the call nor leaves the rotation serving a cached
 * failure for the next 15 s.
 *
 * @param {(string|null)[]} candidates
 * @param {Function} [fetchImpl] injectable for tests
 */
export async function opencodeBunFetchWithRotation(url, init = {}, candidates = [null], fetchImpl = opencodeBunFetch) {
  const list = Array.isArray(candidates) && candidates.length ? candidates : [null];
  const now = Date.now();
  const ready = list.filter((proxy) => (PROXY_COOLDOWN_UNTIL.get(proxyKey(proxy)) || 0) <= now);

  if (list.length > 1 && ready.length === 0) {
    let earliest = Infinity;
    let cached = null;
    for (const proxy of list) {
      const entry = PROXY_LAST_ERROR.get(proxyKey(proxy));
      const until = PROXY_COOLDOWN_UNTIL.get(proxyKey(proxy)) || 0;
      if (entry && until < earliest) {
        earliest = until;
        cached = entry;
      }
    }
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("retry-after", String(Math.max(0, Math.ceil((earliest - Date.now()) / 1000))));
      return exhaustedResponse(cached.status, headers, cached.text);
    }
  }

  const attempts = ready.length ? ready : list;
  // 502/503/504 also come back from the sidecar when a proxy tunnel itself
  // fails, so they must move the rotation to the next egress as well.
  const retryable = new Set([429, 502, 503, 504]);
  const maxRounds = transientRetryAttempts();

  for (let round = 0; ; round++) {
    let lastResponse = null;
    let lastError = null;
    let transient = false;

    for (const proxy of attempts) {
      if (init.signal?.aborted) throw init.signal.reason || new Error("OpenCode request aborted");
      try {
        const response = await fetchImpl(url, init, proxy);
        if (!retryable.has(response.status)) {
          PROXY_COOLDOWN_UNTIL.delete(proxyKey(proxy));
          PROXY_LAST_ERROR.delete(proxyKey(proxy));
          return response;
        }
        const text = await response.text();
        const headers = new Headers(response.headers);
        lastResponse = { status: response.status, headers, text };
        if (response.status === 429 && retryAfterMs(headers) <= 0) {
          transient = true;
          dbg("FETCH", `OPENCODE 429 (transient) on ${proxyKey(proxy)}; trying next egress`);
          continue;
        }
        const waitMs = response.status === 429 ? retryAfterMs(headers) : 0;
        const cooldownMs = waitMs > 0 ? waitMs : 15_000;
        rememberProxyState(PROXY_COOLDOWN_UNTIL, proxyKey(proxy), Date.now() + cooldownMs);
        rememberProxyState(PROXY_LAST_ERROR, proxyKey(proxy), { status: response.status, headers, text });
        dbg("FETCH", `OPENCODE ${response.status} on ${proxyKey(proxy)}; trying next egress`);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        lastError = error;
        rememberProxyState(PROXY_COOLDOWN_UNTIL, proxyKey(proxy), Date.now() + 15_000);
        dbg("FETCH", `OPENCODE proxy ${proxyKey(proxy)} failed (${error.message}); trying next`);
      }
    }

    if (transient && round < maxRounds) {
      const delayMs = transientRetryDelayMs(round);
      dbg("FETCH", `OPENCODE burst-throttled; retry ${round + 1}/${maxRounds} in ${delayMs}ms`);
      await sleep(delayMs, init.signal);
      continue;
    }

    if (lastResponse) {
      return exhaustedResponse(lastResponse.status, lastResponse.headers, lastResponse.text);
    }
    throw lastError || new Error("OpenCode request failed on every egress");
  }
}
