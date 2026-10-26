import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
  getProxyPools: vi.fn(),
  createProxyPool: vi.fn(async (data) => ({ id: `pool-${data.leg}`, ...data })),
  updateProxyPool: vi.fn(async (id, data) => ({ id, ...data })),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ githubRelayPat: "" })),
  updateSettings: vi.fn(async () => ({})),
}));

const models = await import("@/models");
const localDb = await import("@/lib/localDb");
const gh = await import("../../src/lib/network/githubRelay.js");
const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");
const { POST } = await import("../../src/app/api/proxy-pools/github-deploy/route.js");
const { refreshGithubRelayPools } = await import("../../src/shared/services/githubRelayRefresh.js");

const realFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = handler;
}

function postRoute(body) {
  return new Request("http://localhost/api/proxy-pools/github-deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonResponse(json, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    headers: new Headers(headers),
  };
}

function stateFile(url, leg = 1, startedAt = new Date().toISOString()) {
  return jsonResponse({
    content: Buffer.from(JSON.stringify({ leg, url, startedAt })).toString("base64"),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  models.getProxyPools.mockResolvedValue([]);
  localDb.getSettings.mockResolvedValue({ githubRelayPat: "" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("githubRelay helpers", () => {
  it("relay source speaks the shared header spec and ships an IP-header strip list", () => {
    const code = gh.GITHUB_RELAY_SERVER_CODE;
    expect(code).toContain("x-relay-target");
    expect(code).toContain("x-relay-path");
    expect(code).toContain("/__relay_health");
    expect(code).toContain("STRIP_HEADERS.has");
    for (const header of [
      "x-forwarded-for", "forwarded", "x-real-ip", "true-client-ip",
      "cf-connecting-ip", "x-vercel-forwarded-for", "x-relay-target",
    ]) {
      expect(code).toContain(`"${header}"`);
    }
    // Runs in a bare node:20-alpine container, so no ESM imports or deps.
    expect(code).not.toMatch(/\bexport\b/);
    expect(code).toContain('require("node:http")');
  });

  it("parses the tunnel URL out of noisy cloudflared output", () => {
    const log = [
      "2026-10-26T00:00:00Z INF Thank you for trying Cloudflare Tunnel.",
      "2026-10-26T00:00:01Z INF +-----------------------------------------+",
      "2026-10-26T00:00:01Z INF |  https://api.trycloudflare.com        |",
      "2026-10-26T00:00:02Z INF |  https://brave-otter-1234.trycloudflare.com  |",
    ].join("\n");
    expect(gh.parseTunnelUrl(log)).toBe("https://brave-otter-1234.trycloudflare.com");
    expect(gh.parseTunnelUrl("no tunnel here")).toBeNull();
  });

  it("generates a workflow with schedule, dispatch, matrix legs and per-leg state branches", () => {
    const yaml = gh.buildGithubWorkflowYaml({ legs: 2 });
    expect(yaml).toContain('cron: "0 */5 * * *"');
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("contents: write");
    expect(yaml).toContain("leg: [1, 2]");
    expect(yaml).toContain("group: relay-leg-${{ matrix.leg }}");
    expect(yaml).toContain("cancel-in-progress: false");
    expect(yaml).toContain("trycloudflare");
    expect(yaml).toContain("relay-state-");
    expect(yaml).toContain("/__relay_health");
    expect(yaml).toContain("nohup ./cloudflared");
    // No Docker: Bun runs the relay directly on the runner.
    expect(yaml).toContain("oven-sh/setup-bun");
    expect(yaml).toContain("nohup bun server.js");
    expect(yaml).not.toContain("docker");
    // The tunnel hostname resolves a few seconds after it is printed; probing
    // once fails with "Could not resolve host" (observed live, 10/10 legs).
    expect(yaml).toContain("READY=1");
    expect(yaml).toContain("Relay health check failed");
    // GITHUB_TOKEN is not in the step env automatically; without this mapping
    // the push URL is "x-access-token:@..." and git exits 128.
    expect(yaml).toContain("GITHUB_TOKEN: ${{ github.token }}");
  });

  it("builds the three repo files (no Dockerfile)", () => {
    const paths = gh.buildGithubRelayFiles({ legs: 1 }).map((file) => file.path);
    expect(paths).toEqual(["server.js", "README.md", ".github/workflows/relay.yml"]);
    expect(gh).not.toHaveProperty("GITHUB_DOCKERFILE");
  });

  it("decodes the state file and ignores 404s", async () => {
    const state = await gh.readRepoState({
      pat: "ghp",
      repoFullName: "me/relay",
      leg: 3,
      fetchImpl: async (url) => {
        expect(url).toContain("state/relay-3.json?ref=relay-state-3");
        return stateFile("https://leg3.trycloudflare.com", 3);
      },
    });
    expect(state.url).toBe("https://leg3.trycloudflare.com");

    const missing = await gh.readRepoState({
      pat: "ghp",
      repoFullName: "me/relay",
      leg: 1,
      fetchImpl: async () => jsonResponse({ message: "Not Found" }, 404),
    });
    expect(missing).toBeNull();
  });

  it("health check reports false instead of throwing", async () => {
    const ok = await gh.verifyRelayHealth("https://leg1.trycloudflare.com/", {
      fetchImpl: async () => jsonResponse({ ok: true }),
    });
    expect(ok).toBe(true);

    const down = await gh.verifyRelayHealth("https://leg1.trycloudflare.com", {
      fetchImpl: async () => { throw new Error("boom"); },
    });
    expect(down).toBe(false);
  });
});

describe("POST /api/proxy-pools/github-deploy", () => {
  function deployFetch({ stateUrls = {}, failDispatch = false } = {}) {
    const seen = [];

    return {
      seen,
      handler: async (url, init = {}) => {
        const method = (init.method || "GET").toUpperCase();
        seen.push(`${method} ${url}`);

        if (url === "https://api.github.com/user") {
          expect(init.headers.Authorization).toBe("Bearer ghp_test");
          return jsonResponse({ login: "me" }, 200, { "x-oauth-scopes": "repo, workflow" });
        }
        if (url === "https://api.github.com/repos/me/9router-relay") {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        if (url === "https://api.github.com/user/repos") {
          const body = JSON.parse(init.body);
          expect(body).toMatchObject({ name: "9router-relay", private: false, auto_init: true });
          return jsonResponse({ full_name: "me/9router-relay", default_branch: "main" }, 201);
        }
        if (url === "https://api.github.com/repos/me/9router-relay/git/ref/heads/main") {
          return jsonResponse({ object: { sha: "head1" } });
        }
        if (url === "https://api.github.com/repos/me/9router-relay/git/blobs") {
          return jsonResponse({ sha: `blob-${seen.length}` }, 201);
        }
        if (url === "https://api.github.com/repos/me/9router-relay/git/trees") {
          const body = JSON.parse(init.body);
          expect(body.base_tree).toBe("head1");
          expect(body.tree).toHaveLength(3);
          return jsonResponse({ sha: "tree1" }, 201);
        }
        if (url === "https://api.github.com/repos/me/9router-relay/git/commits") {
          const body = JSON.parse(init.body);
          expect(body.parents).toEqual(["head1"]);
          return jsonResponse({ sha: "commit1" }, 201);
        }
        if (url === "https://api.github.com/repos/me/9router-relay/git/refs/heads/main") {
          expect(JSON.parse(init.body).sha).toBe("commit1");
          return jsonResponse({});
        }
        if (/\/git\/ref\/heads\/relay-state-\d+$/.test(url)) {
          return jsonResponse({ message: "Not Found" }, 404);
        }
        if (url === "https://api.github.com/repos/me/9router-relay/git/refs") {
          return jsonResponse({}, 201);
        }
        if (url.endsWith("/actions/workflows/relay.yml/dispatches")) {
          return failDispatch
            ? jsonResponse({ message: "Not Found" }, 404)
            : jsonResponse({}, 204);
        }
        const contentsMatch = url.match(/contents\/state\/relay-(\d+)\.json\?ref=relay-state-(\d+)$/);
        if (contentsMatch) {
          const url2 = stateUrls[contentsMatch[1]];
          return url2
            ? stateFile(url2, Number(contentsMatch[1]))
            : jsonResponse({ message: "Not Found" }, 404);
        }
        if (/^https:\/\/leg\d\.trycloudflare\.com\/__relay_health$/.test(url)) {
          return jsonResponse({ ok: true });
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      },
    };
  }

  it("rejects missing credentials with 400 before touching GitHub", async () => {
    stubFetch(async () => { throw new Error("must not call GitHub"); });
    const res = await POST(postRoute({ owner: "me", repo: "relay" }));
    expect(res.status).toBe(400);
    expect(models.createProxyPool).not.toHaveBeenCalled();
  });

  it("rejects an invalid token with 401", async () => {
    stubFetch(async () => jsonResponse({ message: "Bad credentials" }, 401));
    const res = await POST(postRoute({ pat: "bad", owner: "me", repo: "relay" }));
    expect(res.status).toBe(401);
    expect(models.createProxyPool).not.toHaveBeenCalled();
  });

  it("creates the repo, commits files, dispatches and waits for leg URLs", async () => {
    const { handler } = deployFetch({
      stateUrls: {
        1: "https://leg1.trycloudflare.com",
        2: "https://leg2.trycloudflare.com",
      },
    });
    stubFetch(handler);

    const res = await POST(postRoute({
      pat: "ghp_test",
      owner: "me",
      repo: "9router-relay",
      legs: 2,
      savePat: false,
      waitForUrls: true,
    }));

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.pendingLegs).toEqual([]);
    expect(data.deployUrl).toBe("https://leg1.trycloudflare.com");

    expect(models.createProxyPool).toHaveBeenCalledTimes(2);
    expect(models.createProxyPool).toHaveBeenCalledWith(expect.objectContaining({
      type: "github",
      repoFullName: "me/9router-relay",
      leg: 1,
      proxyUrl: "",
      stateBranch: "relay-state-1",
      workflowPath: ".github/workflows/relay.yml",
      deployStatus: "pending",
    }));
    expect(models.updateProxyPool).toHaveBeenCalledWith("pool-1", expect.objectContaining({
      proxyUrl: "https://leg1.trycloudflare.com",
      deployStatus: "ready",
    }));
    expect(localDb.updateSettings).not.toHaveBeenCalled();
  });

  it("is non-blocking by default: returns pending legs without waiting for URLs", async () => {
    const { handler, seen } = deployFetch();
    stubFetch(handler);

    const res = await POST(postRoute({
      pat: "ghp_test",
      owner: "me",
      repo: "9router-relay",
      legs: 2,
      savePat: false,
    }));

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.pendingLegs).toEqual([1, 2]);
    expect(data.deployUrl).toBeNull();
    expect(models.updateProxyPool).not.toHaveBeenCalled();
    // No state-file reads when the route does not wait.
    expect(seen.some((entry) => entry.includes("/contents/state/"))).toBe(false);
  });

  it("surfaces a taken repository name", async () => {
    stubFetch(async (url) => {
      if (url === "https://api.github.com/user") {
        return jsonResponse({ login: "me" }, 200, { "x-oauth-scopes": "repo, workflow" });
      }
      if (url === "https://api.github.com/repos/me/9router-relay") {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (url === "https://api.github.com/user/repos") {
        return jsonResponse({ message: "name already exists" }, 422);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const res = await POST(postRoute({ pat: "ghp_test", owner: "me", repo: "9router-relay" }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/already exists/i);
  });
});

describe("githubRelayRefresh", () => {
  const pool = {
    id: "pool-1",
    type: "github",
    repoFullName: "me/9router-relay",
    leg: 1,
    proxyUrl: "https://old.trycloudflare.com",
  };

  beforeEach(() => {
    localDb.getSettings.mockResolvedValue({ githubRelayPat: "ghp_test" });
    models.getProxyPools.mockResolvedValue([{ ...pool }]);
  });

  it("rewrites proxyUrl when the state file has a new healthy URL", async () => {
    stubFetch(async (url) => {
      if (url.includes("/contents/state/relay-1.json")) {
        return stateFile("https://new.trycloudflare.com", 1);
      }
      if (url.endsWith("/__relay_health")) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch: ${url}`);
    });

    await refreshGithubRelayPools();

    expect(models.updateProxyPool).toHaveBeenCalledWith("pool-1", {
      proxyUrl: "https://new.trycloudflare.com",
      deployStatus: "ready",
      lastError: null,
    });
  });

  it("keeps the old URL when the new tunnel is not healthy", async () => {
    stubFetch(async (url) => {
      if (url.includes("/contents/state/relay-1.json")) {
        return stateFile("https://dead.trycloudflare.com", 1);
      }
      if (url.endsWith("/__relay_health")) return jsonResponse({ ok: false }, 502);
      throw new Error(`unexpected fetch: ${url}`);
    });

    await refreshGithubRelayPools();

    expect(models.updateProxyPool).toHaveBeenCalledWith("pool-1", {
      lastError: "Relay URL is not responding",
    });
    expect(models.updateProxyPool).not.toHaveBeenCalledWith(
      "pool-1",
      expect.objectContaining({ proxyUrl: expect.any(String) })
    );
  });

  it("does nothing when the URL is unchanged", async () => {
    stubFetch(async (url) => {
      if (url.includes("/contents/state/relay-1.json")) {
        return stateFile(pool.proxyUrl, 1);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await refreshGithubRelayPools();

    expect(models.updateProxyPool).not.toHaveBeenCalled();
  });

  it("re-dispatches the workflow when the newest leg is stale", async () => {
    const repo = "me/stale-repo";
    const oldUrl = "https://stale.trycloudflare.com";
    const startedAt = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    localDb.getSettings.mockResolvedValue({ githubRelayPat: "ghp_test" });
    models.getProxyPools.mockResolvedValue([
      { id: "pool-1", type: "github", repoFullName: repo, leg: 1, proxyUrl: oldUrl },
    ]);

    const calls = [];
    stubFetch(async (url, init = {}) => {
      const method = (init.method || "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (url.includes("/contents/state/relay-1.json")) return stateFile(oldUrl, 1, startedAt);
      if (url.includes("/actions/workflows/relay.yml/runs?per_page=1")) {
        return jsonResponse({ workflow_runs: [{ status: "completed" }] });
      }
      if (url.endsWith("/actions/workflows/relay.yml/dispatches")) {
        expect(JSON.parse(init.body)).toEqual({ ref: "main" });
        return jsonResponse({}, 204);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    await refreshGithubRelayPools();

    expect(calls).toContain(
      "POST https://api.github.com/repos/me/stale-repo/actions/workflows/relay.yml/dispatches"
    );
    // The URL did not change, so no pool write.
    expect(models.updateProxyPool).not.toHaveBeenCalled();
  });

  it("does not re-dispatch while a run is already active", async () => {
    const repo = "me/active-repo";
    const oldUrl = "https://stale2.trycloudflare.com";
    const startedAt = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    localDb.getSettings.mockResolvedValue({ githubRelayPat: "ghp_test" });
    models.getProxyPools.mockResolvedValue([
      { id: "pool-1", type: "github", repoFullName: repo, leg: 1, proxyUrl: oldUrl },
    ]);

    const calls = [];
    stubFetch(async (url, init = {}) => {
      const method = (init.method || "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (url.includes("/contents/state/relay-1.json")) return stateFile(oldUrl, 1, startedAt);
      if (url.includes("/actions/workflows/relay.yml/runs?per_page=1")) {
        return jsonResponse({ workflow_runs: [{ status: "in_progress" }] });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    await refreshGithubRelayPools();

    expect(calls.some((entry) => entry.includes("/dispatches"))).toBe(false);
  });

  it("does not re-dispatch a fresh repo", async () => {
    const repo = "me/fresh-repo";
    const url = "https://fresh.trycloudflare.com";
    localDb.getSettings.mockResolvedValue({ githubRelayPat: "ghp_test" });
    models.getProxyPools.mockResolvedValue([
      { id: "pool-1", type: "github", repoFullName: repo, leg: 1, proxyUrl: url },
    ]);

    const calls = [];
    stubFetch(async (requestUrl) => {
      calls.push(requestUrl);
      if (requestUrl.includes("/contents/state/relay-1.json")) return stateFile(url, 1);
      throw new Error(`unexpected fetch: ${requestUrl}`);
    });

    await refreshGithubRelayPools();

    expect(calls.some((entry) => entry.includes("/actions/"))).toBe(false);
  });

  it("returns early when no PAT is configured", async () => {
    localDb.getSettings.mockResolvedValue({ githubRelayPat: "" });
    stubFetch(async () => { throw new Error("must not fetch"); });

    await refreshGithubRelayPools();

    expect(models.getProxyPools).not.toHaveBeenCalled();
  });

  it("single-flights concurrent ticks", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;

    stubFetch(async () => {
      calls += 1;
      await gate;
      return jsonResponse({ message: "Not Found" }, 404);
    });

    const first = refreshGithubRelayPools();
    const second = refreshGithubRelayPools();
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });
});

describe("github pool proxy resolution", () => {
  it("routes a github pool through the relay branch", async () => {
    models.getProxyPoolById.mockResolvedValue({
      id: "g1",
      isActive: true,
      proxyUrl: "https://leg1.trycloudflare.com",
      type: "github",
      strictProxy: false,
    });

    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "g1" });
    expect(cfg.source).toBe("github");
    expect(cfg.vercelRelayUrl).toBe("https://leg1.trycloudflare.com");
    expect(cfg.connectionProxyEnabled).toBe(false);
  });
});
