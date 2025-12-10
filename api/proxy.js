// api/proxy.js
// Proxy Vercel -> Cloud Run, compatible GET/POST multipart + CORS + preflight

export default async function handler(req, res) {
  try {
    // 1) CORS & preflight
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', '*');
    if (req.method === 'OPTIONS') {
      res.status(204).end(); // preflight OK
      return;
    }

    // 2) Base API depuis variable d'env (sinon fallback)
    const base = (process.env.API_BASE || 'https://url-matcher-70649262164.europe-west1.run.app').replace(/\/$/, '');

    // 3) Recompose le chemin demandé après /api/proxy
    const path = (req.url || '').replace(/^\/api\/proxy/, '') || '/';
    const target = base + (path.startsWith('/') ? path : '/' + path);

    // 4) Copie des headers "safe" uniquement
    const fwdHeaders = {};
    const allow = ['content-type', 'authorization'];
    for (const [k, v] of Object.entries(req.headers || {})) {
      const key = String(k).toLowerCase();
      if (allow.includes(key)) fwdHeaders[key] = v;
    }

    // 5) Corps (stream) seulement si ce n'est pas GET/HEAD
    const init = {
      method: req.method,
      headers: fwdHeaders,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req
    };

    // 6) Appel Cloud Run
    const r = await fetch(target, init);

    // 7) Relais du statut + corps binaire
    const buf = Buffer.from(await r.arrayBuffer());
    // propage quelques headers utiles (facultatif)
    ['content-type', 'content-disposition'].forEach(h => {
      const hv = r.headers.get(h);
      if (hv) res.setHeader(h, hv);
    });

    res.status(r.status).send(buf);
  } catch (err) {
    // Log simple côté réponse pour debug rapide
    res.status(500).json({
      error: 'proxy_failed',
      message: err?.message || String(err)
    });
  }
}
