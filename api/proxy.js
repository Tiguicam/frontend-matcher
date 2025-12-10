// /api/proxy.js — Proxy sécurisé avec Auth Supabase + quotas + logs
import { createClient } from "@supabase/supabase-js";

const { API_BASE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

// Client ADMIN Supabase (valide les tokens)
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// Détecte une sonde POST /match "vide" (aucun corps)
function isEmptyPostMatch(req, path) {
  if (path !== "/match" || req.method !== "POST") return false;
  const cl = req.headers["content-length"];
  const hasBody = cl && Number(cl) > 0;
  return !hasBody;
}

// Détermine si l'appel est une sonde de santé (pas de login requis)
function isHealthProbe(req, path) {
  if ((req.method === "GET" || req.method === "HEAD") && path === "/") return true;
  if (req.method === "GET" && path === "/openapi.json") return true;
  if (req.method === "OPTIONS" && path === "/match") return true;
  // Autoriser POST /match vide pour ton bouton "Test de fonctionnement"
  if (isEmptyPostMatch(req, path)) return true;
  return false;
}

// Lit le flux binaire tel quel (upload Excel)
async function readRawBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  const started = Date.now();

  try {
    if (!API_BASE) {
      return res.status(500).json({ error: "API_BASE missing" });
    }

    const upstreamPath = (req.query.path || "/").toString();
    if (!upstreamPath.startsWith("/")) {
      return res.status(400).json({ error: "Invalid path" });
    }

    // 1) AUTH (sauf health checks)
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

    // 2) QUOTA (limiter /match à 200/jour) — seulement pour un vrai POST (pas la sonde vide)
    if (upstreamPath === "/match" && req.method === "POST" && userId && !isEmptyPostMatch(req, upstreamPath)) {
      try {
        const { data: q } = await supabaseAdmin.rpc("check_quota", {
          p_user_id: userId,
          p_limit: 200
        });
        if (q?.over_limit) {
          return res.status(429).json({ error: "Quota exceeded" });
        }
      } catch {
        // RPC absente → ignorer
      }
    }

    // 3) Relais Cloud Run
    const target = API_BASE.replace(/\/$/, "") + upstreamPath;

    // Copie des headers (ne jamais transmettre Authorization à Cloud Run)
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (key === "authorization" || key === "host") continue;
      forwardHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    if (userId) forwardHeaders["x-user-id"] = userId;

    // Corps brut
    let rawBody = null;
    if (!["GET", "HEAD"].includes(req.method)) {
      rawBody = await readRawBody(req);
      // Laisser l'absence de body telle quelle pour la sonde POST vide (pas de Content-Length forcé)
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers: forwardHeaders,
      body: rawBody
    });

    // 4) Préparation de la réponse
    const respHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!["transfer-encoding", "content-encoding"].includes(k.toLowerCase())) {
        respHeaders[k] = v;
      }
    });

    const status = upstream.status;
    const ab = await upstream.arrayBuffer();
    const payload = Buffer.from(ab);

    // 5) LOG (best-effort)
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
    } catch {
      // ne bloque pas
    }

    // 6) Envoi final
    for (const [k, v] of Object.entries(respHeaders)) {
      res.setHeader(k, v);
    }
    res.status(status).send(payload);

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
