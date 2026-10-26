// GitHub Relay URL rotation.
//
// Each leg publishes its current quick-tunnel URL to state/relay-<leg>.json on
// relay-state-<leg>. Tunnel URLs rotate every ~5h (and on every workflow
// restart), so pools would go dead without this poller. Modeled on
// quotaAutoPing: one global interval per process, single-flight ticks.

import { getProxyPools, updateProxyPool } from "@/models";
import { getSettings } from "@/lib/localDb";
import { GITHUB_RELAY_CONFIG } from "@/shared/constants/config";
import {
  dispatchRelayWorkflow,
  hasActiveRelayRun,
  readRepoState,
  verifyRelayHealth,
} from "@/lib/network/githubRelay";

const g = global.__githubRelayRefresh ??= {
  interval: null,
  running: false,
  dispatchAt: new Map(),
};

// GitHub's scheduler can skip or delay runs; when the newest leg is older than
// the job lifetime the tunnels are gone, so re-dispatch from here.
const STALE_AFTER_MS = (GITHUB_RELAY_CONFIG.jobSeconds + 900) * 1000;
const DISPATCH_COOLDOWN_MS = 10 * 60 * 1000;

async function dispatchStaleRepos({ pat, repos, fetchImpl }) {
  const now = Date.now();
  g.dispatchAt ??= new Map();

  for (const [repoFullName, entry] of repos) {
    if (!entry.latestStartedAt || now - entry.latestStartedAt < STALE_AFTER_MS) continue;

    const lastDispatch = g.dispatchAt.get(repoFullName) || 0;
    if (now - lastDispatch < DISPATCH_COOLDOWN_MS) continue;
    if (await hasActiveRelayRun({ pat, repoFullName, fetchImpl })) continue;

    try {
      await dispatchRelayWorkflow({ pat, repoFullName, ref: entry.defaultBranch, fetchImpl });
      g.dispatchAt.set(repoFullName, now);
      console.warn(`[GithubRelay] legs stale for ${repoFullName}; workflow re-dispatched`);
    } catch (error) {
      console.warn(`[GithubRelay] re-dispatch failed for ${repoFullName}: ${error.message}`);
    }
  }
}

export async function refreshGithubRelayPools({ settings, fetchImpl = fetch } = {}) {
  if (g.running) return;
  g.running = true;

  try {
    const resolvedSettings = settings ?? await getSettings();
    const pat = String(resolvedSettings?.githubRelayPat || "").trim();
    if (!pat) return;

    const pools = (await getProxyPools()).filter(
      (pool) => pool.type === "github" && pool.repoFullName
    );

    const repos = new Map();

    for (const pool of pools) {
      try {
        const state = await readRepoState({
          pat,
          repoFullName: pool.repoFullName,
          leg: pool.leg,
          fetchImpl,
        });

        if (state?.startedAt) {
          const startedAt = Date.parse(state.startedAt) || 0;
          const entry = repos.get(pool.repoFullName) || {
            latestStartedAt: 0,
            defaultBranch: pool.defaultBranch || "main",
          };
          entry.latestStartedAt = Math.max(entry.latestStartedAt, startedAt);
          repos.set(pool.repoFullName, entry);
        }

        if (!state || state.url === pool.proxyUrl) continue;

        if (!(await verifyRelayHealth(state.url, { fetchImpl }))) {
          await updateProxyPool(pool.id, { lastError: "Relay URL is not responding" });
          continue;
        }

        await updateProxyPool(pool.id, {
          proxyUrl: state.url,
          deployStatus: "ready",
          lastError: null,
        });
      } catch (error) {
        console.warn(`[GithubRelay] refresh failed for pool ${pool.id}: ${error.message}`);
      }
    }

    await dispatchStaleRepos({ pat, repos, fetchImpl });
  } catch (error) {
    console.warn("[GithubRelay] tick error:", error.message);
  } finally {
    g.running = false;
  }
}

export function startGithubRelayRefresh() {
  if (g.interval) return;
  refreshGithubRelayPools().catch(() => {});
  g.interval = setInterval(() => {
    refreshGithubRelayPools().catch(() => {});
  }, GITHUB_RELAY_CONFIG.pollIntervalMs);
  if (g.interval.unref) g.interval.unref();
}

export function stopGithubRelayRefresh() {
  if (!g.interval) return;
  clearInterval(g.interval);
  g.interval = null;
}

export function configureGithubRelayRefresh(settings) {
  if (String(settings?.githubRelayPat || "").trim()) startGithubRelayRefresh();
  else stopGithubRelayRefresh();
}
