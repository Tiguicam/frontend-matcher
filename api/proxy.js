// /api/proxy.js — Proxy sécurisé (Supabase Auth + quotas + logs) avec double parsing du path
import { createClient } from "@supabase/supabase-js";

const { API_BASE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// Détection POST /match vide (sonde)
function isEmptyPostMatch(req, path) {
  if (path !== "/match" || req.method !== "POST") return false;
  const cl = req.headers["content-length"];
  const hasBody = cl && Number(cl) > 0;
  return !hasBody;
}

// Health probes autorisées sans auth
function isHealthProbe(req, path) {
  if ((req.method === "GET" || req.method === "HEAD") && path === "/") return true;
  if (req.method === "GET" && path === "/openapi.json") return true;
  if (req.method === "OPTIONS" && path === "/match") return true;
  if (isEmptyPostMatch(req, path)) return true; // bouton "Test de fonctionnement"
  return false;
}

// Lire le corps brut (uploads/binaire)
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Next/Vercel: désactive le bodyParser pour pouvoir lire le flux brut
export const config = { api: { bodyParser: false } };

// Récupère le chemin amont à partir de ?path= OU du suffixe d'URL /api/proxy/<suffixe>
function resolveUpstreamPath(req) {
  // 1) Priorité au query param ?path=/...
  let p = req.query?.path;
  if (Array.isArray(p)) p = p[0];
  if (typeof p === "string" && p.length > 0) return p.startsWith("/") ? p : `/${p}`;

  // 2) Sinon, on extrait le suffixe réel de l’URL
  //   ex: /api/proxy/match  -> /match
  //       /api/proxy       -> /
  const withoutPrefix = req.url.replace(/^\/api\/proxy(?:\.js)?/i, "");
  if (!withoutPrefix || withoutPrefix === "" || withoutPrefix === "/") return "/";
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

export default async function handler(req, res) {
  const started = Date.now();

  try {
    if (!API_BASE) {
      return res.status(500).json({ error: "API_BASE missing" });
    }

    const upstreamPath = resolveUpstreamPath(req);
    if (!upstreamPath.startsWith("/")) {
      return res.status(400).json({ error: "Invalid path" });
    }

    // DEBUG minimal dans les logs Vercel
    console.log(`[proxy] ${req.method} ${upstreamPath}`);

    // 1) Auth (sauf sondes)
    const health = isHealthProbe(req, upstreamPath);
    const authz = req.headers["authorization"] || "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;

    let userId = null;
    if (!health) {
      if (!token) return res.status(401).json({ error: "Unauthorized" });
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      if (error || !data?.user) return res.status(401).json({ error: "Invalid token" });
      userId = data.user.id;
    }

    // 2) Quota pour les vrais POST /match (pas la sonde vide)
    if (upstreamPath === "/match" && req.method === "POST" && userId && !isEmptyPostMatch(req, upstreamPath)) {
      try {
        const { data: q } = await supabaseAdmin.rpc("check_quota", {
          p_user_id: userId,
          p_limit: 200
        });
        if (q?.over_limit) return res.status(429).json({ error: "Quota exceeded" });
      } catch { /* ignore si RPC absente */ }
    }

    // 3) Build URL Cloud Run
    const target = API_BASE.replace(/\/$/, "") + upstreamPath;

    // 4) Prépare headers (ne jamais forward Authorization)
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (key === "authorization" || key === "host") continue;
      forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    if (userId) forwardHeaders["x-user-id"] = userId;

    // 5) Corps brut (laisser vide pour la sonde POST)
    let rawBody = null;
    if (!["GET", "HEAD"].includes(req.method)) rawBody = await readRawBody(req);

    const upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      body: rawBody
    });

    // 6) Réponse Cloud Run -> client
    const respHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!["transfer-encoding", "content-encoding"].includes(k.toLowerCase())) {
        respHeaders[k] = v;
      }
    });

    const status = upstream.status;
    const ab = await upstream.arrayBuffer();
    const payload = Buffer.from(ab);

    // 7) Log best-effort
    try {
      await supabaseAdmin.from("api_logs").insert({
        user_id: userId,
        route: upstreamPath,
        method: req.method,
        status_code: status,
        duration_ms: Date.now() - started,
        bytes_in: rawBody?.length || 0,
        bytes_out: payload.length
      });
    } catch { /* no-op */ }

    // 8) Envoi final
    for (const [k, v] of Object.entries(respHeaders)) res.setHeader(k, v);
    return res.status(status).send(payload);

  } catch (err) {
    console.error("Proxy error:", err);
    try {
      await supabaseAdmin.from("api_logs").insert({
        user_id: null,
        route: "/proxy-exception",
        method: "INTERNAL",
        status_code: 500,
        error: String(err?.message || err)
      });
    } catch {}
    return res.status(500).json({ error: "Proxy crash" });
  }
}
