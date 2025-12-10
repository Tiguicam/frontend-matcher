// api/proxy.js — base d’origine + diagnostic + correctifs minimes
export const config = { api: { bodyParser: false } };

function resolveUpstreamPath(req) {
  // Priorité au ?path=
  let p = req.query?.path;
  if (Array.isArray(p)) p = p[0];
  if (typeof p === "string" && p.length > 0) return p.startsWith("/") ? p : `/${p}`;
  // Sinon, suffixe après /api/proxy
  const withoutPrefix = req.url.replace(/^\/api\/proxy(?:\.js)?/i, "");
  if (!withoutPrefix || withoutPrefix === "/" || withoutPrefix === "") return "/";
  return withoutPrefix.startsWith("/") ? withoutPrefix : `/${withoutPrefix}`;
}

function isEmptyPostMatch(req, upstreamPath) {
  if (req.method !== "POST" || upstreamPath !== "/match") return false;
  const cl = req.headers["content-length"];
  const hasBody = cl && Number(cl) > 0;
  return !hasBody;
}

export default async function handler(req, res) {
  const API_BASE = process.env.API_BASE; // ex: https://url-matcher-70649262164.europe-west1.run.app
  if (!API_BASE) return res.status(500).json({ error: "API_BASE is not defined" });

  const upstreamPath = resolveUpstreamPath(req);
  const base = API_BASE.replace(/\/$/, "");
  const url = base + (upstreamPath.startsWith("/") ? upstreamPath : `/${upstreamPath}`);

  // Mode debug: ?debug=1 -> n’appelle pas Cloud Run, renvoie un JSON d’info
  const debug = req.query?.debug === "1";
  if (debug) {
    return res.status(200).json({
      note: "debug mode (no upstream call)",
      method: req.method,
      req_url: req.url,
      resolved_upstreamPath: upstreamPath,
      target_url: url,
      api_base: base,
      has_body: !["GET","HEAD"].includes(req.method),
      content_length: req.headers["content-length"] || null,
      auth_present: !!req.headers["authorization"],
    });
  }

  // Copie d’en-têtes simples (éviter host/content-length/authorization)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (["host", "content-length", "authorization"].includes(key)) continue;
    headers[key] = v;
  }

  const init = { method: req.method, headers, redirect: "manual" };

  // Sonde POST /match vide → pas de body ; sinon on streame tel quel
  const isProbeEmptyPost = isEmptyPostMatch(req, upstreamPath);
  if (!["GET", "HEAD"].includes(req.method) && !isProbeEmptyPost) {
    init.body = req; // stream brut (multipart incl.)
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
