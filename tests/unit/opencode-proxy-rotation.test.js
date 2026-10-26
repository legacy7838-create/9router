import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  opencodeBunFetchWithRotation,
  resolveBunProxyCandidates,
  runOpencodeMaintenance,
} from "../../open-sse/utils/opencodeBunTransport.js";

const savedList = process.env.OC_PROXY_LIST;
const savedFile = process.env.OC_PROXY_FILE;
const savedAttempts = process.env.OC_TRANSIENT_RETRY_ATTEMPTS;
const savedDelay = process.env.OC_TRANSIENT_RETRY_DELAY_MS;
const savedQuotaCooldown = process.env.OC_QUOTA_COOLDOWN_MS;

afterEach(() => {
  if (savedList === undefined) delete process.env.OC_PROXY_LIST;
  else process.env.OC_PROXY_LIST = savedList;
  if (savedFile === undefined) delete process.env.OC_PROXY_FILE;
  else process.env.OC_PROXY_FILE = savedFile;
  if (savedAttempts === undefined) delete process.env.OC_TRANSIENT_RETRY_ATTEMPTS;
  else process.env.OC_TRANSIENT_RETRY_ATTEMPTS = savedAttempts;
  if (savedDelay === undefined) delete process.env.OC_TRANSIENT_RETRY_DELAY_MS;
  else process.env.OC_TRANSIENT_RETRY_DELAY_MS = savedDelay;
  if (savedQuotaCooldown === undefined) delete process.env.OC_QUOTA_COOLDOWN_MS;
  else process.env.OC_QUOTA_COOLDOWN_MS = savedQuotaCooldown;
});

function freeUsage429(retryAfter = "3600") {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "limit" } }),
    { status: 429, headers: { "content-type": "application/json", "retry-after": retryAfter } },
  );
}

function bare429() {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "limit" } }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
}

function uniqueProxy(label) {
  return `http://rotation-${label}-${Math.random().toString(36).slice(2)}.test:8080`;
}

describe("resolveBunProxyCandidates", () => {
  it("uses OC_PROXY_LIST in order, normalizes entries, and never appends direct", () => {
    process.env.OC_PROXY_LIST = "127.0.0.1:18090,http://127.0.0.1:18091 127.0.0.1:18090";
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(resolveBunProxyCandidates("https://opencode.ai", { connectionProxyEnabled: true })).toEqual([
      "http://127.0.0.1:18090",
      "http://127.0.0.1:18091",
    ]);
  });

  it("ignores the pool and leaves directly when the proxy option is off", () => {
    process.env.OC_PROXY_LIST = "127.0.0.1:18090,127.0.0.1:18091";
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(resolveBunProxyCandidates("https://opencode.ai", { connectionProxyEnabled: false })).toEqual([null]);
    expect(resolveBunProxyCandidates("https://opencode.ai", null)).toEqual([null]);
  });

  it("prefers the configured proxy, then the pool for rotation", () => {
    process.env.OC_PROXY_LIST = "127.0.0.1:18090";
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(
      resolveBunProxyCandidates("https://opencode.ai", {
        connectionProxyEnabled: true,
        connectionProxyUrl: "127.0.0.1:7890",
      }),
    ).toEqual(["http://127.0.0.1:7890", "http://127.0.0.1:18090"]);
  });

  it("stays direct when the configured proxy is bypassed by noProxy", () => {
    process.env.OC_PROXY_LIST = "127.0.0.1:18090";
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(
      resolveBunProxyCandidates("https://opencode.ai", {
        connectionProxyEnabled: true,
        connectionProxyUrl: "127.0.0.1:7890",
        connectionNoProxy: "opencode.ai",
      }),
    ).toEqual([null]);
  });

  it("uses the lane pool for the built-in free lane when autoPool is set", () => {
    process.env.OC_PROXY_LIST = "127.0.0.1:18101,127.0.0.1:18102";
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(resolveBunProxyCandidates("https://opencode.ai", { autoPool: true })).toEqual([
      "http://127.0.0.1:18101",
      "http://127.0.0.1:18102",
    ]);
  });

  it("autoPool keeps the relay first and appends the lane pool", () => {
    process.env.OC_PROXY_LIST = "127.0.0.1:18101";
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(
      resolveBunProxyCandidates("https://opencode.ai", {
        autoPool: true,
        vercelRelayUrl: "https://relay.example.vercel.app",
      }),
    ).toEqual([
      { relay: "https://relay.example.vercel.app" },
      "http://127.0.0.1:18101",
    ]);
  });

  it("appends relay fallbacks after the primary relay, deduped", () => {
    delete process.env.OC_PROXY_LIST;
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(
      resolveBunProxyCandidates("https://opencode.ai", {
        vercelRelayUrl: "https://leg1.trycloudflare.com",
        vercelRelayFallbacks: ["https://leg2.trycloudflare.com", "https://leg1.trycloudflare.com", ""],
      }),
    ).toEqual([
      { relay: "https://leg1.trycloudflare.com" },
      { relay: "https://leg2.trycloudflare.com" },
    ]);
  });

  it("falls back to a direct candidate when no proxy is configured", () => {
    delete process.env.OC_PROXY_LIST;
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(resolveBunProxyCandidates("https://opencode.ai", null)).toEqual([null]);
    expect(resolveBunProxyCandidates("https://opencode.ai", { connectionProxyEnabled: true })).toEqual([null]);
  });

  it("picks up pool file rewrites and caches unchanged reads", () => {
    delete process.env.OC_PROXY_LIST;
    const file = path.join(os.tmpdir(), `oc-pool-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    process.env.OC_PROXY_FILE = file;
    try {
      fs.writeFileSync(file, "10.0.0.1:8000\n");
      expect(resolveBunProxyCandidates("https://opencode.ai", { connectionProxyEnabled: true })).toEqual([
        "http://10.0.0.1:8000",
      ]);

      fs.writeFileSync(file, "10.0.0.2:8001,10.0.0.3:8002\n");
      const future = new Date(Date.now() + 5_000);
      fs.utimesSync(file, future, future);
      expect(resolveBunProxyCandidates("https://opencode.ai", { connectionProxyEnabled: true })).toEqual([
        "http://10.0.0.2:8001",
        "http://10.0.0.3:8002",
      ]);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe("opencodeBunFetchWithRotation", () => {
  it("retries the same request on the next proxy after a 429", async () => {
    const p1 = uniqueProxy("a1");
    const p2 = uniqueProxy("a2");
    const calls = [];
    const fetchImpl = async (_url, _init, proxy) => {
      calls.push(proxy);
      return proxy === p1 ? freeUsage429() : new Response("ok", { status: 200 });
    };

    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(200);
    expect(calls).toEqual([p1, p2]);
  });

  it("returns the last 429 when every proxy is limited", async () => {
    const p1 = uniqueProxy("b1");
    const p2 = uniqueProxy("b2");
    const fetchImpl = async () => freeUsage429("120");

    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(429);
    expect(await res.text()).toContain("FreeUsageLimitError");
  });

  it("adds a human reset hint and reset header to the final 429", async () => {
    const p1 = uniqueProxy("g1");
    const p2 = uniqueProxy("g2");
    const res = await opencodeBunFetchWithRotation(
      "https://opencode.ai",
      {},
      [p1, p2],
      async () => freeUsage429("600"),
    );

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("600");
    expect(res.headers.get("x-9router-reset")).toMatch(/T.*Z$/);
    const body = await res.json();
    expect(body.error.message).toContain("free quota resets in 10m");
  });

  it("skips a proxy while its retry-after window is active", async () => {
    const p1 = uniqueProxy("c1");
    const p2 = uniqueProxy("c2");
    const calls = [];
    const fetchImpl = async (_url, _init, proxy) => {
      calls.push(proxy);
      return proxy === p1 ? freeUsage429("3600") : new Response("ok", { status: 200 });
    };

    await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    calls.length = 0;
    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(200);
    expect(calls).toEqual([p2]);
  });

  it("moves to the next proxy when a tunnel returns 502", async () => {
    const p1 = uniqueProxy("f1");
    const p2 = uniqueProxy("f2");
    const calls = [];
    const fetchImpl = async (_url, _init, proxy) => {
      calls.push(proxy);
      return proxy === p1 ? new Response("bad gateway", { status: 502 }) : new Response("ok", { status: 200 });
    };

    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(200);
    expect(calls).toEqual([p1, p2]);
  });

  it("tries the next proxy when a connection fails", async () => {
    const p1 = uniqueProxy("d1");
    const p2 = uniqueProxy("d2");
    const calls = [];
    const fetchImpl = async (_url, _init, proxy) => {
      calls.push(proxy);
      if (proxy === p1) throw new Error("ECONNREFUSED");
      return new Response("ok", { status: 200 });
    };

    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(200);
    expect(calls).toEqual([p1, p2]);
  });

  it("treats a bare 429 as transient instead of parking the whole rotation", async () => {
    process.env.OC_TRANSIENT_RETRY_ATTEMPTS = "0";
    const p1 = uniqueProxy("h1");
    const p2 = uniqueProxy("h2");
    const calls = [];
    const fetchImpl = async (_url, _init, proxy) => {
      calls.push(proxy);
      return bare429();
    };

    await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(calls).toEqual([p1, p2]);
    calls.length = 0;
    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(429);
    expect(calls).toEqual([p1, p2]);
  });

  it("retries a burst-throttled request after a short backoff", async () => {
    process.env.OC_TRANSIENT_RETRY_ATTEMPTS = "1";
    process.env.OC_TRANSIENT_RETRY_DELAY_MS = "1";
    const p1 = uniqueProxy("j1");
    const p2 = uniqueProxy("j2");
    const calls = [];
    const fetchImpl = async (_url, _init, proxy) => {
      calls.push(proxy);
      if (calls.length <= 2) return bare429();
      return proxy === p2 ? new Response("ok", { status: 200 }) : bare429();
    };

    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(200);
    expect(calls).toEqual([p1, p2, p1, p2]);
  });

  it("does not retry a quota 429 that carries retry-after", async () => {
    process.env.OC_TRANSIENT_RETRY_ATTEMPTS = "2";
    process.env.OC_TRANSIENT_RETRY_DELAY_MS = "1";
    const p1 = uniqueProxy("k1");
    const p2 = uniqueProxy("k2");
    const calls = [];
    const fetchImpl = async (_url, _init, proxy) => {
      calls.push(proxy);
      return freeUsage429("3600");
    };

    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(429);
    expect(calls).toEqual([p1, p2]);
  });

  it("routes through the Vercel relay instead of going direct", () => {
    delete process.env.OC_PROXY_LIST;
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(
      resolveBunProxyCandidates("https://opencode.ai", {
        connectionProxyEnabled: false,
        vercelRelayUrl: "https://relay.example.vercel.app",
      }),
    ).toEqual([{ relay: "https://relay.example.vercel.app" }]);
  });

  it("prefers the relay, then the configured proxy and pool", () => {
    process.env.OC_PROXY_LIST = "127.0.0.1:18090";
    process.env.OC_PROXY_FILE = "/nonexistent/proxies.txt";
    expect(
      resolveBunProxyCandidates("https://opencode.ai", {
        connectionProxyEnabled: true,
        connectionProxyUrl: "127.0.0.1:7890",
        vercelRelayUrl: "https://relay.example.vercel.app",
      }),
    ).toEqual([
      { relay: "https://relay.example.vercel.app" },
      "http://127.0.0.1:7890",
      "http://127.0.0.1:18090",
    ]);
  });

  it("retries the next egress when a relay returns a quota 429", async () => {
    const relay = { relay: "https://relay.example.vercel.app" };
    const proxy = uniqueProxy("r1");
    const calls = [];
    const fetchImpl = async (_url, _init, egress) => {
      calls.push(egress);
      return egress === relay ? freeUsage429("3600") : new Response("ok", { status: 200 });
    };

    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [relay, proxy], fetchImpl);
    expect(res.status).toBe(200);
    expect(calls).toEqual([relay, proxy]);
  });

  it("retries the next relay leg when the first leg's runner IP is out of quota", async () => {
    const tag = Math.random().toString(36).slice(2);
    const leg1 = { relay: `https://leg1-${tag}.trycloudflare.com` };
    const leg2 = { relay: `https://leg2-${tag}.trycloudflare.com` };
    const leg3 = { relay: `https://leg3-${tag}.trycloudflare.com` };
    const calls = [];
    const fetchImpl = async (_url, _init, egress) => {
      calls.push(egress);
      return egress === leg1 ? freeUsage429("54000") : new Response("ok", { status: 200 });
    };

    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [leg1, leg2, leg3], fetchImpl);
    expect(res.status).toBe(200);
    expect(calls).toEqual([leg1, leg2]);
  });

  it("prunes expired cooldown state during maintenance", async () => {
    const p1 = uniqueProxy("i1");
    const p2 = uniqueProxy("i2");
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return freeUsage429("3600");
    };

    await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(calls).toBe(2);
    // Still cooling down: the cached 429 is served without hitting upstream.
    await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(calls).toBe(2);

    await runOpencodeMaintenance(Date.now() + 3_601_000);

    await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(calls).toBe(4);
  });

  it("re-checks a quota-parked egress after the cooldown cap", async () => {
    process.env.OC_QUOTA_COOLDOWN_MS = "20";
    const p1 = uniqueProxy("l1");
    const p2 = uniqueProxy("l2");
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return freeUsage429("3600");
    };

    await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(calls).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(calls).toBe(4);
  });

  it("serves the cached 429 once every proxy is cooling down", async () => {
    const p1 = uniqueProxy("e1");
    const p2 = uniqueProxy("e2");
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return freeUsage429("3600");
    };

    await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(calls).toBe(2);
    const res = await opencodeBunFetchWithRotation("https://opencode.ai", {}, [p1, p2], fetchImpl);
    expect(res.status).toBe(429);
    expect(calls).toBe(2);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
