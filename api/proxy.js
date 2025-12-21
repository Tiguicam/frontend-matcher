// api/proxy.js — VERSION CORRIGÉE ET STABLE
// Objectifs :
// - Proxy Vercel -> Cloud Run
// - CORS verrouillé
// - Forward correct des headers (dont Authorization)
// - Support JSON + multipart/form-data (streaming)
// - Auth check optionnel côté proxy (Supabase) pour les endpoints protégés

export const config = { api: { bodyParser: false } };

// ====================================================================
// PATH RESOLUTION
// ====================================================================
function resolveUpstreamPath(req) {
  let p = req.query?.path;

  if (Array.isArray(p)) p = p[0];

  if (typeof p === "string" && p.length > 0) {
    try {
      p = decodeURIComponent(p);
    } catch {}
    return p.startsWith("/") ? p : `/${p}`;
  }

  // fallback /api/proxy/...
  const withoutPrefix = req.url.replace(/^\/api\/proxy(?:\.js)?/i, "");
  if (!withoutPrefix || withoutPrefix === "/" || withoutPrefix === "") return "/";

  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

// POST /match vide = health check
function isEmptyPostMatch(req, upstreamPath) {
  if (req.method !== "POST" || upstreamPath !== "/match") return false;
  const cl = req.headers["content-length"];
  return !(cl && Number(cl) > 0);
}

// ====================================================================
// CORS (VERROUILLÉ)
// ====================================================================
function corsAllow(req, res) {
  const allowedOrigins = new Set([
    "https://frontend-matcher.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);

  const origin = req.headers.origin;

  // Autorise uniquement les origins whitelistées.
  // Si pas d'Origin (server-to-server, curl), on ne met pas Allow-Origin.
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "authorization,content-type"
  );

  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
}

// ====================================================================
// AUTH (OPTIONNEL) — Validation Supabase côté proxy
// ====================================================================
// En pratique, ton backend FastAPI valide déjà le JWT.
// Ici, on le garde si tu veux :
// - faire échouer plus tôt (avant Cloud Run)
// - injecter x-user-id
async function validateSupabaseUserFromBearer(req) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env missing (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  }

  const authz = req.headers["authorization"] || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
  if (!token) return { userId: null, error: "Unauthorized" };

  // Import uniquement au besoin
  const { createClient } = await import("@supabase/supabase-js");
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return { userId: null, error: "Invalid token" };

  return { userId: data.user.id, error: null };
}

// ====================================================================
// HANDLER
// ====================================================================
export default async function handler(req, res) {
  corsAllow(req, res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const API_BASE = process.env.API_BASE;
  if (!API_BASE) return res.status(500).json({ error: "API_BASE not defined" });

  const upstreamPath = resolveUpstreamPath(req);

  const url =
    API_BASE.replace(/\/$/, "") +
    (upstreamPath.startsWith("/") ? upstreamPath : "/" + upstreamPath);

  // ====================================================================
  // PROTECTED PATHS (doivent envoyer Authorization)
  // ====================================================================
  const protectedPaths = new Set(["/match", "/debug-url"]);

  // /match vide = probe/health, pas besoin d'auth
  const isProbe = upstreamPath === "/match" && isEmptyPostMatch(req, upstreamPath);

  const needsAuth =
    req.method === "POST" && protectedPaths.has(upstreamPath) && !isProbe;

  let userId = null;

  // ====================================================================
  // EARLY AUTH CHECK (OPTIONNEL)
  // ====================================================================
  // Si tu préfères laisser Cloud Run/FastAPI faire l'auth uniquement,
  // tu peux supprimer ce bloc. Mais il aide à diagnostiquer rapidement.
  if (needsAuth) {
    try {
      const result = await validateSupabaseUserFromBearer(req);
      if (result.error) return res.status(401).json({ error: result.error });
      userId = result.userId;
    } catch (e) {
      return res.status(500).json({
        error: "Supabase validation failed",
        detail: e?.message || String(e),
      });
    }
  }

  // ====================================================================
  // PREPARE HEADERS — IMPORTANT : on FORWARD Authorization
  // ====================================================================
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    // host/content-length ne doivent pas être forward (proxies)
    if (["host", "content-length"].includes(key)) continue;

    headers[key] = v;
  }

  // Force explicit forward Authorization (sécurité anti-surprise)
  if (req.headers.authorization) headers["authorization"] = req.headers.authorization;

  if (userId) headers["x-user-id"] = userId;

  const init = { method: req.method, headers, redirect: "manual" };
  const probeEmpty = isProbe;

  // ====================================================================
  // BODY HANDLING — JSON + FORMDATA (streaming)
  // ====================================================================
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !probeEmpty) {
    const ct = String(req.headers["content-type"] || "");

    // JSON (fix Vercel)
    if (ct.includes("application/json")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      init.body = raw;
      headers["content-type"] = "application/json";
    } else {
      // multipart/form-data ou autre (stream)
      // Node fetch: streaming requires duplex: "half"
      // @ts-ignore
      init.duplex = "half";
      init.body = req;
    }
  }

  // ====================================================================
  // FORWARD → Cloud Run
  // ====================================================================
  try {
    const upstream = await fetch(url, init);

    // Copie headers réponse
    upstream.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (!["content-encoding", "transfer-encoding"].includes(lk)) {
        res.setHeader(key, value);
      }
    });

    // Repose CORS après forward
    corsAllow(req, res);

    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.status(upstream.status).send(buf);
  } catch (e) {
    return res.status(502).json({
      error: "Bad gateway",
      detail: e?.message || String(e),
    });
  }
}
