// api/proxy.js — VERSION CORRIGÉE ET STABLE

export const config = { api: { bodyParser: false } };

// ====================================================================
// PATH RESOLUTION
// ====================================================================
function resolveUpstreamPath(req) {
  let p = req.query?.path;

  if (Array.isArray(p)) p = p[0];

  if (typeof p === "string" && p.length > 0) {
    try { p = decodeURIComponent(p); } catch {}
    return p.startsWith("/") ? p : `/${p}`;
  }

  // fallback /api/proxy/... 
  const withoutPrefix = req.url.replace(/^\/api\/proxy(?:\.js)?/i, "");
  if (!withoutPrefix || withoutPrefix === "/" || withoutPrefix === "")
    return "/";

  return withoutPrefix.startsWith("/")
    ? withoutPrefix
    : `/${withoutPrefix}`;
}

// POST /match vide = health check
function isEmptyPostMatch(req, upstreamPath) {
  if (req.method !== "POST" || upstreamPath !== "/match") return false;
  const cl = req.headers["content-length"];
  return !(cl && Number(cl) > 0);
}

// ====================================================================
// CORS
// ====================================================================
function corsAllow(req, res) {
  const origin = req.headers.origin || "*";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");

  res.setHeader(
    "Access-Control-Allow-Headers",
    req.headers["access-control-request-headers"] ||
      "authorization,content-type"
  );

  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
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
  if (!API_BASE)
    return res.status(500).json({ error: "API_BASE not defined" });

  const upstreamPath = resolveUpstreamPath(req);

  const url =
    API_BASE.replace(/\/$/, "") +
    (upstreamPath.startsWith("/") ? upstreamPath : "/" + upstreamPath);

  // ====================================================================
  // AUTH pour POST /match réel
  // ====================================================================
  const needsAuth =
    req.method === "POST" &&
    upstreamPath === "/match" &&
    !isEmptyPostMatch(req, upstreamPath);

  let userId = null;

if (needsAuth) {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Supabase env missing" });
  }

  // Import Supabase uniquement quand on en a besoin (POST /match réel)
  const { createClient } = await import("@supabase/supabase-js");

  const supabaseAdmin = createClient(
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const authz = req.headers["authorization"] || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;

  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user)
    return res.status(401).json({ error: "Invalid token" });

  userId = data.user.id;
}


  // ====================================================================
  // PREPARE HEADERS
  // ====================================================================
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (["host", "content-length", "authorization"].includes(key)) continue;
    headers[key] = v;
  }

  if (userId) headers["x-user-id"] = userId;

  const init = { method: req.method, headers, redirect: "manual" };

  const probeEmpty = isEmptyPostMatch(req, upstreamPath);

  // ====================================================================
  // BODY HANDLING — FIX JSON + FORMDATA
  // ====================================================================
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !probeEmpty) {
    const ct = String(req.headers["content-type"] || "");

    // --- JSON --- (fix Vercel)
    if (ct.includes("application/json")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString("utf8");
      init.body = raw;
      headers["content-type"] = "application/json";
    }
    // --- FormData (match) ---
    else {
      // Node fetch: streaming requires duplex: "half"
      // Vercel runtime supports this.
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

    upstream.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (!["content-encoding", "transfer-encoding"].includes(lk)) {
        res.setHeader(key, value);
      }
    });

    corsAllow(req, res);

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.status(upstream.status).send(buf);
  } catch (e) {
    return res.status(502).json({
      error: "Bad gateway",
      detail: e?.message || String(e)
    });
  }
}
