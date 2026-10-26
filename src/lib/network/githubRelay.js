// GitHub Actions relay helpers.
//
// Deploy model (per https://docs.github.com/en/rest):
//   1. verify PAT (GET /user)
//   2. create/reuse a public repo
//   3. commit server.js + Dockerfile + .github/workflows/relay.yml (git tree API)
//   4. create one state branch per leg (relay-state-<n>)
//   5. workflow_dispatch; each matrix job runs a container on its own runner
//      and exposes it through a Cloudflare quick tunnel
//   6. the job commits state/relay-<n>.json to its own branch; the URL poller
//      in src/shared/services/githubRelayRefresh.js rewrites pool.proxyUrl
//
// The relay speaks the same header spec as the Vercel/Cloudflare/Deno/Netlify
// relays (x-relay-target + x-relay-path), so proxyAwareFetch needs no changes.

import { GITHUB_RELAY_CONFIG } from "@/shared/constants/config.js";

export const GITHUB_API = GITHUB_RELAY_CONFIG.apiBase;
export const STATE_BRANCH_PREFIX = GITHUB_RELAY_CONFIG.stateBranchPrefix;
export const WORKFLOW_PATH = GITHUB_RELAY_CONFIG.workflowPath;

export function githubHeaders(pat) {
  return {
    Authorization: `Bearer ${pat}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "9Router",
  };
}

// Dependency-free Node-compatible server run by Bun on the runner. It must
// stream: provider calls include large POSTs and SSE responses.
export const GITHUB_RELAY_SERVER_CODE = `const http = require("node:http");
const { Readable } = require("node:stream");

const PORT = Number(process.env.PORT || 8080);
const LEG = process.env.LEG || "1";

// Client-IP headers injected by the platform edge must not be forwarded:
// the target would attribute the request (and its rate-limit/quota) to the
// caller's real IP instead of this relay's egress.
const STRIP_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
  "x-relay-target", "x-relay-path",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto",
  "x-forwarded-server", "forwarded", "x-real-ip", "true-client-ip",
  "x-client-ip", "x-cluster-client-ip", "fastly-client-ip",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cdn-loop",
  "x-nf-client-connection-ip", "x-nf-request-id", "x-nf-geo",
  "x-vercel-forwarded-for", "x-vercel-proxied-for",
  "x-azure-clientip", "x-azure-socketip", "x-amz-cf-id",
]);

const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const pathname = (req.url || "/").split("?")[0];

  if (pathname === "/__relay_health") {
    sendJson(res, 200, { ok: true, leg: LEG });
    return;
  }

  const target = req.headers["x-relay-target"];
  const relayPath = req.headers["x-relay-path"] || "/";

  if (!target) {
    sendJson(res, 400, { error: "Missing x-relay-target header" });
    return;
  }

  const targetUrl = String(target).replace(/\\/$/, "") + String(relayPath);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (STRIP_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  const controller = new AbortController();
  req.on("aborted", () => controller.abort());

  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
      signal: controller.signal,
    });

    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) return;
      responseHeaders[key] = value;
    });
    const cookies = typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
    if (cookies.length > 0) responseHeaders["set-cookie"] = cookies;

    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) {
      const body = Readable.fromWeb(upstream.body);
      body.on("error", () => res.destroy());
      body.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, { error: (error && error.message) || "Relay fetch failed" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("[relay] listening on " + PORT + " leg=" + LEG);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;

// Bun, not Node: OpenCode's free tier gates on the outbound TLS/HTTP2
// fingerprint, and Node's undici stack is answered with 429 FreeUsageLimitError
// from the same IP where Bun (the CLI's runtime) gets 200.
export const GITHUB_BUN_VERSION = "1.4.4";

const GITHUB_RELAY_README = `# 9Router relay

Generated by 9Router. The workflow runs the relay server directly on
GitHub-hosted runners under Bun and exposes it through a Cloudflare quick
tunnel (\`*.trycloudflare.com\`).

- Each job (leg) is a separate runner, so each leg gets its own egress IP.
- \`relay-state-<n>\` branches hold the current tunnel URL for each leg.
- Jobs run for ~5h20m; the next scheduled run is queued and takes over.

This repo exists only to host the relay. Do not commit credentials.
`;

export function buildGithubWorkflowYaml({
  legs = 1,
  stateBranchPrefix = STATE_BRANCH_PREFIX,
  jobSeconds = GITHUB_RELAY_CONFIG.jobSeconds,
  relayPort = GITHUB_RELAY_CONFIG.relayPort,
  cron = GITHUB_RELAY_CONFIG.cron,
} = {}) {
  const legList = Array.from({ length: legs }, (_, index) => index + 1);
  const matrix = `[${legList.join(", ")}]`;

  return `name: relay
on:
  schedule:
    - cron: "${cron}"
  workflow_dispatch:
permissions:
  contents: write
jobs:
  relay:
    runs-on: ubuntu-latest
    timeout-minutes: 345
    strategy:
      fail-fast: false
      matrix:
        leg: ${matrix}
    concurrency:
      group: relay-leg-\${{ matrix.leg }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "${GITHUB_BUN_VERSION}"
      - name: Start relay + tunnel
        run: |
          LEG=\${{ matrix.leg }} PORT=${relayPort} nohup bun server.js > relay.log 2>&1 &
          curl -fsSL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
          chmod +x cloudflared
          nohup ./cloudflared tunnel --url http://localhost:${relayPort} --no-autoupdate > cf.log 2>&1 &
          URL=""
          for i in $(seq 1 60); do
            URL=$(grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' cf.log | head -1)
            [ -n "$URL" ] && break
            sleep 2
          done
          if [ -z "$URL" ]; then cat cf.log; exit 1; fi
          # The tunnel URL is printed before its DNS record is live; probing it
          # immediately fails with "Could not resolve host". Retry until the
          # edge answers through the tunnel (up to ~2min).
          READY=""
          for i in $(seq 1 40); do
            if curl -fsS --max-time 10 "$URL/__relay_health" > /dev/null 2>&1; then
              READY=1
              break
            fi
            sleep 3
          done
          if [ -z "$READY" ]; then echo "Relay health check failed: $URL"; cat cf.log; exit 1; fi
          echo "RELAY_URL=$URL" >> "$GITHUB_ENV"
      - name: Publish state
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: |
          BRANCH="${stateBranchPrefix}\${{ matrix.leg }}"
          D=$(mktemp -d)
          cd "$D"
          git init -q
          git remote add origin "https://x-access-token:\${GITHUB_TOKEN}@github.com/\${GITHUB_REPOSITORY}.git"
          if git fetch -q origin "$BRANCH"; then
            git checkout -q -B "$BRANCH" FETCH_HEAD
          else
            git checkout -q --orphan "$BRANCH"
          fi
          mkdir -p state
          printf '{"leg":%s,"url":"%s","startedAt":"%s","runId":"%s"}\\n' \\
            "\${{ matrix.leg }}" "$RELAY_URL" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "\${{ github.run_id }}" > "state/relay-\${{ matrix.leg }}.json"
          git add state
          git -c user.name=github-actions[bot] \\
            -c user.email=41898282+github-actions[bot]@users.noreply.github.com \\
            commit -q -m "relay leg \${{ matrix.leg }} up"
          git push -q origin "HEAD:refs/heads/$BRANCH"
      - name: Keepalive
        run: |
          END=$((SECONDS+${jobSeconds}))
          while [ $SECONDS -lt $END ]; do
            pgrep -f 'bun server.js' >/dev/null || exit 1
            pgrep -f 'cloudflared tunnel' >/dev/null || exit 1
            sleep 60
          done
      - name: Cleanup
        if: always()
        run: |
          pkill -f 'bun server.js' || true
          pkill -f 'cloudflared tunnel' || true
`;
}

export function buildGithubRelayFiles({
  legs = 1,
  stateBranchPrefix = STATE_BRANCH_PREFIX,
  jobSeconds = GITHUB_RELAY_CONFIG.jobSeconds,
  relayPort = GITHUB_RELAY_CONFIG.relayPort,
  cron = GITHUB_RELAY_CONFIG.cron,
} = {}) {
  return [
    { path: "server.js", content: GITHUB_RELAY_SERVER_CODE },
    { path: "README.md", content: GITHUB_RELAY_README },
    {
      path: WORKFLOW_PATH,
      content: buildGithubWorkflowYaml({ legs, stateBranchPrefix, jobSeconds, relayPort, cron }),
    },
  ];
}

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

export function parseTunnelUrl(logText) {
  const matches = String(logText || "").match(TUNNEL_URL_PATTERN) || [];
  for (const match of matches) {
    if (/^https:\/\/api\.trycloudflare\.com$/i.test(match)) continue;
    return match;
  }
  return null;
}

export async function readRepoState({
  pat,
  repoFullName,
  leg,
  branchPrefix = STATE_BRANCH_PREFIX,
  fetchImpl = fetch,
} = {}) {
  const branch = `${branchPrefix}${leg}`;
  const path = `state/relay-${leg}.json`;
  const url = `${GITHUB_API}/repos/${repoFullName}/contents/${path}?ref=${encodeURIComponent(branch)}`;

  const res = await fetchImpl(url, { headers: githubHeaders(pat) });
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!data || typeof data.content !== "string") return null;

  try {
    const parsed = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    return typeof parsed?.url === "string" && parsed.url ? parsed : null;
  } catch {
    return null;
  }
}

export async function verifyRelayHealth(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const base = String(url || "").trim().replace(/\/$/, "");
  if (!base) return false;

  try {
    const res = await fetchImpl(`${base}${GITHUB_RELAY_CONFIG.healthPath}`, {
      method: "GET",
      headers: { "User-Agent": "9Router" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function dispatchRelayWorkflow({
  pat,
  repoFullName,
  ref = "main",
  fetchImpl = fetch,
  attempts = 1,
  retryDelayMs = 0,
} = {}) {
  const workflowFile = WORKFLOW_PATH.split("/").pop();
  const url = `${GITHUB_API}/repos/${repoFullName}/actions/workflows/${workflowFile}/dispatches`;
  let lastError = "Failed to dispatch relay workflow";

  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { ...githubHeaders(pat), "Content-Type": "application/json" },
      body: JSON.stringify({ ref }),
    });
    if (res.ok) return true;

    const data = await res.json().catch(() => ({}));
    lastError = data.message || data.error || lastError;
    // A freshly committed workflow file takes a few seconds to register.
    if (res.status !== 404 || attempt === attempts - 1) break;
    await sleep(retryDelayMs);
  }

  throw new Error(lastError);
}

export async function hasActiveRelayRun({ pat, repoFullName, fetchImpl = fetch } = {}) {
  const workflowFile = WORKFLOW_PATH.split("/").pop();
  const url = `${GITHUB_API}/repos/${repoFullName}/actions/workflows/${workflowFile}/runs?per_page=1`;

  try {
    const res = await fetchImpl(url, { headers: githubHeaders(pat) });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null);
    const status = data?.workflow_runs?.[0]?.status;
    return ["queued", "in_progress", "waiting", "pending", "requested"].includes(status);
  } catch {
    return false;
  }
}
