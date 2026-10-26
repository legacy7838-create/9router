import { NextResponse } from "next/server";
import { createProxyPool, getProxyPools, updateProxyPool } from "@/models";
import { getSettings, updateSettings } from "@/lib/localDb";
import { GITHUB_RELAY_CONFIG } from "@/shared/constants/config";
import {
  GITHUB_API,
  STATE_BRANCH_PREFIX,
  WORKFLOW_PATH,
  buildGithubRelayFiles,
  dispatchRelayWorkflow,
  githubHeaders,
  readRepoState,
  verifyRelayHealth,
} from "@/lib/network/githubRelay";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function githubFetch(url, { pat, method = "GET", body }, fetchImpl = fetch) {
  return fetchImpl(url, {
    method,
    headers: {
      ...githubHeaders(pat),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function readError(res, fallback) {
  const data = await res.json().catch(() => ({}));
  return data.message || data.error || fallback;
}

async function ensureRepo({ pat, owner, login, repo, fetchImpl }) {
  const repoRes = await githubFetch(`${GITHUB_API}/repos/${owner}/${repo}`, { pat }, fetchImpl);
  if (repoRes.ok) return repoRes.json();

  if (repoRes.status !== 404) {
    throw new Error(await readError(repoRes, "Failed to read GitHub repository"));
  }

  const createUrl = String(owner).toLowerCase() === String(login).toLowerCase()
    ? `${GITHUB_API}/user/repos`
    : `${GITHUB_API}/orgs/${owner}/repos`;

  const createRes = await githubFetch(createUrl, {
    pat,
    method: "POST",
    body: { name: repo, private: false, auto_init: true, description: "9Router relay" },
  }, fetchImpl);

  if (!createRes.ok) {
    if (createRes.status === 422) {
      throw new Error(`Repository "${owner}/${repo}" already exists or the name is invalid.`);
    }
    throw new Error(await readError(createRes, "Failed to create GitHub repository"));
  }

  return createRes.json();
}

async function commitFiles({ pat, repoFullName, branch, files, fetchImpl }) {
  const refRes = await githubFetch(`${GITHUB_API}/repos/${repoFullName}/git/ref/heads/${branch}`, { pat }, fetchImpl);
  if (!refRes.ok) {
    throw new Error(await readError(refRes, `Failed to read branch "${branch}"`));
  }

  const headSha = (await refRes.json())?.object?.sha;
  if (!headSha) {
    throw new Error(`Branch "${branch}" has no head commit`);
  }

  const tree = [];
  for (const file of files) {
    const blobRes = await githubFetch(`${GITHUB_API}/repos/${repoFullName}/git/blobs`, {
      pat,
      method: "POST",
      body: { content: Buffer.from(file.content).toString("base64"), encoding: "base64" },
    }, fetchImpl);
    if (!blobRes.ok) {
      throw new Error(await readError(blobRes, `Failed to upload ${file.path}`));
    }
    const blob = await blobRes.json();
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const treeRes = await githubFetch(`${GITHUB_API}/repos/${repoFullName}/git/trees`, {
    pat,
    method: "POST",
    body: { base_tree: headSha, tree },
  }, fetchImpl);
  if (!treeRes.ok) {
    throw new Error(await readError(treeRes, "Failed to create git tree"));
  }
  const treeSha = (await treeRes.json())?.sha;

  const commitRes = await githubFetch(`${GITHUB_API}/repos/${repoFullName}/git/commits`, {
    pat,
    method: "POST",
    body: { message: "9Router relay", tree: treeSha, parents: [headSha] },
  }, fetchImpl);
  if (!commitRes.ok) {
    throw new Error(await readError(commitRes, "Failed to create commit"));
  }
  const commitSha = (await commitRes.json())?.sha;

  const updateRes = await githubFetch(`${GITHUB_API}/repos/${repoFullName}/git/refs/heads/${branch}`, {
    pat,
    method: "PATCH",
    body: { sha: commitSha, force: false },
  }, fetchImpl);
  if (!updateRes.ok) {
    throw new Error(await readError(updateRes, `Failed to update branch "${branch}"`));
  }

  return commitSha;
}

async function ensureBranch({ pat, repoFullName, branch, sha, fetchImpl }) {
  const refRes = await githubFetch(`${GITHUB_API}/repos/${repoFullName}/git/ref/heads/${branch}`, { pat }, fetchImpl);
  if (refRes.ok) return;

  if (refRes.status !== 404) {
    throw new Error(await readError(refRes, `Failed to inspect branch "${branch}"`));
  }

  const createRes = await githubFetch(`${GITHUB_API}/repos/${repoFullName}/git/refs`, {
    pat,
    method: "POST",
    body: { ref: `refs/heads/${branch}`, sha },
  }, fetchImpl);

  // 422 = created concurrently; anything else is fatal.
  if (!createRes.ok && createRes.status !== 422) {
    throw new Error(await readError(createRes, `Failed to create branch "${branch}"`));
  }
}

async function waitForFirstUrls({ pat, repoFullName, pools, fetchImpl }) {
  const pending = new Set(pools.map((pool) => pool.id));
  const deadline = Date.now() + GITHUB_RELAY_CONFIG.deployPollMs;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const pool of pools) {
      if (!pending.has(pool.id)) continue;

      const state = await readRepoState({
        pat,
        repoFullName,
        leg: pool.leg,
        fetchImpl,
      }).catch(() => null);

      if (!state) continue;
      if (!(await verifyRelayHealth(state.url, { fetchImpl }))) continue;

      const updated = await updateProxyPool(pool.id, {
        proxyUrl: state.url,
        deployStatus: "ready",
        lastError: null,
      });
      Object.assign(pool, updated || { proxyUrl: state.url, deployStatus: "ready", lastError: null });
      pending.delete(pool.id);
    }

    if (pending.size === 0) break;
    await sleep(GITHUB_RELAY_CONFIG.deployPollStepMs);
  }

  return pending;
}

// POST /api/proxy-pools/github-deploy
export async function POST(request) {
  try {
    const body = await request.json();
    const patInput = typeof body.pat === "string" ? body.pat.trim() : "";
    const settings = await getSettings();
    const pat = patInput || settings.githubRelayPat;
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    const repo = typeof body.repo === "string" ? body.repo.trim() : "";
    const requestedLegs = Number(body.legs);
    const legs = Number.isInteger(requestedLegs) && requestedLegs > 0
      ? Math.min(requestedLegs, GITHUB_RELAY_CONFIG.maxLegs)
      : GITHUB_RELAY_CONFIG.maxLegs;
    const savePat = body.savePat !== false;
    // Non-blocking by default: return once the workflow is dispatched and let
    // the refresh poller fill in tunnel URLs as legs publish them.
    const waitForUrls = body.waitForUrls === true;

    if (!pat) {
      return NextResponse.json({ error: "GitHub personal access token is required" }, { status: 400 });
    }
    if (!OWNER_PATTERN.test(owner)) {
      return NextResponse.json({ error: "Invalid GitHub owner or organization name" }, { status: 400 });
    }
    if (!REPO_PATTERN.test(repo)) {
      return NextResponse.json({ error: "Invalid GitHub repository name" }, { status: 400 });
    }

    // 1. Verify the token and learn the login (repo creation target depends on it).
    const userRes = await githubFetch(`${GITHUB_API}/user`, { pat });
    if (!userRes.ok) {
      return NextResponse.json({ error: "GitHub token is invalid or expired" }, { status: 401 });
    }
    const user = await userRes.json();
    const scopes = String(userRes.headers?.get?.("x-oauth-scopes") || "");
    const scopeWarning = scopes && !/\b(repo|workflow)\b/.test(scopes)
      ? "Token is missing the repo/workflow scopes required to create the relay repo."
      : null;

    // 2. Create or reuse the public repo.
    const repoInfo = await ensureRepo({ pat, owner, login: user.login, repo, fetchImpl: fetch });
    const repoFullName = repoInfo.full_name || `${owner}/${repo}`;
    const defaultBranch = repoInfo.default_branch || "main";

    // 3. Commit the relay files in a single commit.
    const files = buildGithubRelayFiles({ legs });
    const commitSha = await commitFiles({
      pat,
      repoFullName,
      branch: defaultBranch,
      files,
      fetchImpl: fetch,
    });

    // 4. One state branch per leg so concurrent legs never race on push.
    for (let leg = 1; leg <= legs; leg += 1) {
      await ensureBranch({
        pat,
        repoFullName,
        branch: `${STATE_BRANCH_PREFIX}${leg}`,
        sha: commitSha,
        fetchImpl: fetch,
      });
    }

    // 5. Kick off the workflow (scheduled runs take over from here).
    await dispatchRelayWorkflow({
      pat,
      repoFullName,
      ref: defaultBranch,
      fetchImpl: fetch,
      attempts: 10,
      retryDelayMs: 3000,
    });

    // 6. Persist the PAT so the URL-rotation poller survives restarts.
    if (savePat) {
      await updateSettings({ githubRelayPat: pat });
      import("@/shared/services/githubRelayRefresh")
        .then(({ configureGithubRelayRefresh, refreshGithubRelayPools }) => {
          configureGithubRelayRefresh({ githubRelayPat: pat });
          // Legs need ~30s to publish their first URL; probe once soon instead
          // of waiting for the next scheduler tick.
          const timer = setTimeout(() => {
            refreshGithubRelayPools({ settings: { githubRelayPat: pat } }).catch(() => {});
          }, 30000);
          timer.unref?.();
        })
        .catch((error) => console.warn("[GithubRelay] poller start failed:", error.message));
    }

    // 7. Create or reuse one pool per leg.
    const existingPools = await getProxyPools();
    const existingByLeg = new Map(
      existingPools
        .filter((pool) => pool.type === "github" && pool.repoFullName === repoFullName)
        .map((pool) => [Number(pool.leg), pool])
    );

    const pools = [];
    for (let leg = 1; leg <= legs; leg += 1) {
      const existing = existingByLeg.get(leg);
      if (existing) {
        pools.push(existing);
        continue;
      }

      const pool = await createProxyPool({
        name: `${repo}-relay-${leg}`,
        proxyUrl: "",
        type: "github",
        repoFullName,
        leg,
        stateBranch: `${STATE_BRANCH_PREFIX}${leg}`,
        workflowPath: WORKFLOW_PATH,
        defaultBranch,
        deployStatus: "pending",
        lastError: "Waiting for first relay URL",
        noProxy: "",
        isActive: true,
        strictProxy: false,
      });
      pools.push(pool);
    }

    // 8. Wait briefly for the first tunnel URLs; stragglers are finished by the poller.
    const pending = waitForUrls
      ? await waitForFirstUrls({ pat, repoFullName, pools, fetchImpl: fetch })
      : new Set(pools.map((pool) => pool.id));

    const deployUrl = pools.find((pool) => pool.proxyUrl)?.proxyUrl || null;
    const pendingLegs = pools
      .filter((pool) => pending.has(pool.id))
      .map((pool) => Number(pool.leg));

    return NextResponse.json({
      proxyPools: pools,
      deployUrl,
      repoFullName,
      stateBranchPrefix: STATE_BRANCH_PREFIX,
      pendingLegs,
      warning: scopeWarning,
    }, { status: 201 });
  } catch (error) {
    console.log("Error deploying GitHub relay:", error);
    return NextResponse.json({ error: error.message || "Deploy failed" }, { status: 500 });
  }
}
