// api/proxy.js — version STABLE (base originale + correctifs) + AUTH MINIMALE
// - Support ?path= ET /api/proxy/<suffixe>
// - Autorise toutes les sondes (dont POST vide /match)
// - Pas de debug
// - Comportement identique à ton proxy d’origine
// - + Auth requise uniquement pour POST /match avec body (vrai upload)

import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

// Résout le chemin amont (supporte les deux syntaxes)
function resolveUpstreamPath(req) {
  let p = req.query?.path;
  if (Array.isArray(p)) p = p[0];
  if (typeof p === "string" && p.length > 0) return p.startsWith("/") ? p : `/${p}`;

  const withoutPrefix = req.url.replace(/^\/api\/proxy(?:\.js)?/i, "");
  if (!withoutPrefix || withoutPrefix === "/" || withoutPrefix === "") return "/";
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

// Détection POST /match vide (health probe)
function isEmptyPostMatch(req, upstreamPath) {
  if (req.method !== "POST" || upstreamPath !== "/match") return false;
  const cl = req.headers["content-length"];
  return !(cl && Number(cl) > 0);
}

export default async function handler(req, res) {
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
  if (userId) headers["x-user-id"] = userId; // optionnel, pour corrélation côté Cloud Run

  const init = {
    method: req.method,
    headers,
    redirect: "manual"
  };

  // POST /match vide = sonde → pas de body
  const isProbeEmpty = isEmptyPostMatch(req, upstreamPath);
  const hasBody = !["GET", "HEAD"].includes(req.method);

  if (hasBody && !isProbeEmpty) {
    init.body = req; // stream brut (uploads)
  }

  try {
    const upstream = await fetch(url, init);

    // Re-propage presque tous les headers
    upstream.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (!["content-encoding", "transfer-encoding"].includes(lk)) {
        res.setHeader(key, value);
      }
    });

    res.status(upstream.status);

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: "Bad gateway", detail: e?.message || String(e) });
  }
}
