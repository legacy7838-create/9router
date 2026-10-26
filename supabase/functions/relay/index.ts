// 9Router relay — Supabase Edge Function
//
// Speaks the shared x-relay-target / x-relay-path spec used by 9router's
// proxy pools (Vercel / Netlify / Deno / Cloudflare relays).
//
// Deploy with the Supabase CLI from the repo root:
//   supabase functions deploy relay --no-verify-jwt
// or paste this file into Dashboard → Edge Functions → relay → Code.
// URL: https://<project-ref>.supabase.co/functions/v1/relay
//
// Optional env (Dashboard → Edge Functions → Secrets):
//   RELAY_ALLOWED_HOSTS="opencode.ai,api.openai.com"   // comma separated; empty = any
//
// Client-IP headers added by Cloudflare/Supabase must NOT be forwarded: the
// target would attribute the request (and its free-tier quota) to the caller's
// real IP instead of this relay's egress, which makes the relay pointless.

const STRIP_HEADERS = new Set([
  // hop-by-hop / framing headers; fetch recomputes these
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  // relay control headers
  "x-relay-target",
  "x-relay-path",
  // caller IP / geo / forwarding headers injected by edges
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-server",
  "forwarded",
  "x-real-ip",
  "true-client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "fastly-client-ip",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cdn-loop",
  "x-nf-client-connection-ip",
  "x-nf-request-id",
  "x-nf-geo",
  "x-vercel-forwarded-for",
  "x-vercel-proxied-for",
  "x-azure-clientip",
  "x-azure-socketip",
  "x-amz-cf-id",
]);

const ALLOWED_HOSTS = (Deno.env.get("RELAY_ALLOWED_HOSTS") ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  const target = request.headers.get("x-relay-target");
  const relayPath = request.headers.get("x-relay-path") || "/";
  if (!target) return json(400, { error: "Missing x-relay-target header" });

  let base: URL;
  try {
    base = new URL(target);
  } catch {
    return json(400, { error: "Invalid x-relay-target" });
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    return json(400, { error: "Only http(s) targets are supported" });
  }
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(base.hostname.toLowerCase())) {
    return json(403, { error: `Target host not allowed: ${base.hostname}` });
  }

  const targetUrl = target.replace(/\/$/, "") + relayPath;

  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!STRIP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    init.duplex = "half";
  }

  try {
    const upstream = await fetch(targetUrl, init);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (error) {
    return json(502, {
      error: error instanceof Error ? error.message : "Relay fetch failed",
    });
  }
});
