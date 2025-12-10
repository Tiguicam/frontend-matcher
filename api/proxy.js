// api/proxy.js — version STABLE (base originale + correctifs)
// - Support ?path= ET /api/proxy/<suffixe>
// - Autorise toutes les sondes (dont POST vide /match)
// - Pas de debug
// - Comportement identique à ton proxy d’origine

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

  // En-têtes à relayer (sans host, content-length, authorization)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (["host", "content-length", "authorization"].includes(key)) continue;
    headers[key] = v;
  }

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
