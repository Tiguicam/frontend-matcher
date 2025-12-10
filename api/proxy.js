// api/proxy.js — base d’origine + auth minimale Supabase (seulement pour POST /match avec body)
import { createClient } from "@supabase/supabase-js";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  const API_BASE = process.env.API_BASE; // ex: https://url-matcher-70649262164.europe-west1.run.app
  if (!API_BASE) {
    return res.status(500).json({ error: "API_BASE is not defined" });
  }

  // -------- Résolution du chemin amont (supporte ?path=/xxx ET /api/proxy/xxx) --------
  function resolveUpstreamPath() {
    const qp = req.query?.path;
    if (typeof qp === "string" && qp.length > 0) return qp.startsWith("/") ? qp : `/${qp}`;
    const withoutPrefix = req.url.replace(/^\/api\/proxy(?:\.js)?/i, "");
    if (!withoutPrefix || withoutPrefix === "" || withoutPrefix === "/") return "/";
    return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
  }
  const upstreamPath = resolveUpstreamPath();

  const base = API_BASE.replace(/\/$/, "");
  const url = base + (upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`);

  // -------- Health probes autorisées sans auth (inclut POST /match vide) ----------
  function isEmptyPostMatch() {
    if (req.method !== "POST" || upstreamPath !== "/match") return false;
    const cl = req.headers["content-length"];
    const hasBody = cl && Number(cl) > 0;
    return !hasBody; // sonde = POST vide
  }
  function isHealthProbe() {
    if ((req.method === "GET" || req.method === "HEAD") && upstreamPath === "/") return true;
    if (req.method === "GET" && upstreamPath === "/openapi.json") return true;
    if (req.method === "OPTIONS" && upstreamPath === "/match") return true;
    if (isEmptyPostMatch()) return true;
    return false;
  }

  // -------- Auth minimale (uniquement pour vrai POST /match avec body) ------------
  let userId = null;
  const needsAuth = req.method === "POST" && upstreamPath === "/match" && !isEmptyPostMatch();

  if (needsAuth) {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

  // -------- Prépare les en-têtes à relayer (sans host/content-length/authorization) ------
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (["host", "content-length", "authorization"].includes(key)) continue; // sécurité
    headers[key] = v;
  }
  if (userId) headers["x-user-id"] = userId; // corrélation côté Cloud Run (optionnel)

  const init = {
    method: req.method,
    headers,
    redirect: "manual"
  };

  // Corps uniquement pour les méthodes avec body
  if (!["GET", "HEAD"].includes(req.method)) {
    // Si c'est une sonde POST vide, on n'envoie pas de body
    if (!isHealthProbe()) {
      // Vercel fournit req comme stream — on le passe tel quel (préserve uploads .xlsx)
      init.body = req;
    }
  }

  try {
    const upstream = await fetch(url, init);

    // Re-propage (la plupart des) headers
    upstream.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (!["content-encoding", "transfer-encoding"].includes(lk)) {
        res.setHeader(key, value);
      }
    });

    res.status(upstream.status);

    // Corps binaire (buffer) pour couvrir JSON / texte / fichiers
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: "Bad gateway", detail: e?.message || String(e) });
  }
}
