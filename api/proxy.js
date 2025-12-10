// api/proxy.js — STABLE + AUTH minimale + CORS proxy
// - Support ?path= ET /api/proxy/<suffixe>
// - Sondes OK (GET /, HEAD /, GET /openapi.json, OPTIONS /match, POST /match vide)
// - Auth requise uniquement pour POST /match avec body
// - CORS géré côté proxy (préflights répondus localement)

import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

// ---------- Utils ----------
function resolveUpstreamPath(req) {
  let p = req.query?.path;
  if (Array.isArray(p)) p = p[0];
  if (typeof p === "string" && p.length > 0) return p.startsWith("/") ? p : `/${p}`;
  const withoutPrefix = req.url.replace(/^\/api\/proxy(?:\.js)?/i, "");
  if (!withoutPrefix || withoutPrefix === "/" || withoutPrefix === "") return "/";
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

function isEmptyPostMatch(req, upstreamPath) {
  if (req.method !== "POST" || upstreamPath !== "/match") return false;
  const cl = req.headers["content-length"];
  return !(cl && Number(cl) > 0);
}

// CORS helpers
function corsAllow(req, res) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "authorization,content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,OPTIONS");
}

// ---------- Handler ----------
export default async function handler(req, res) {
  // CORS: toujours renseigner les headers
  corsAllow(req, res);

  // Préflight: répondre localement
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const API_BASE = process.env.API_BASE;
  if (!API_BASE) return res.status(500).json({ error: "API_BASE is not defined" });

  const upstreamPath = resolveUpstreamPath(req);
  const base = API_BASE.replace(/\/$/, "");
  const url = base + (upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`);

  // === AUTH: requise seulement pour un vrai POST /match (pas la sonde POST vide) ===
  const needsAuth =
    req.method === "POST" &&
    upstreamPath === "/match" &&
    !isEmptyPostMatch(req, upstreamPath);

  let userId = null;
  if (needsAuth) {
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: "Supabase server env missing" });
    }
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });

    const authz = req.headers["authorization"] || "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Invalid token" });
    userId = data.user.id;
  }

  // En-têtes à relayer (sans host, content-length, authorization)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (["host", "content-length", "authorization"].includes(key)) continue;
    headers[key] = v;
  }
  if (userId) headers["x-user-id"] = userId; // optionnel

  const init = { method: req.method, headers, redirect: "manual" };

  // POST /match vide = sonde → pas de body ; sinon on streame (uploads)
  const isProbeEmpty = isEmptyPostMatch(req, upstreamPath);
  const hasBody = !["GET", "HEAD"].includes(req.method);
  if (hasBody && !isProbeEmpty) init.body = req;

  try {
    const upstream = await fetch(url, init);

    // Re-propage presque tous les headers (plus CORS)
    upstream.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (!["content-encoding", "transfer-encoding"].includes(lk)) {
        res.setHeader(key, value);
      }
    });
    corsAllow(req, res); // s'assurer que CORS reste présent sur la réponse

    res.status(upstream.status);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    return res.status(502).json({ error: "Bad gateway", detail: e?.message || String(e) });
  }
}
