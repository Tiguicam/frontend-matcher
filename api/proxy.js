// api/proxy.js
export default async function handler(req, res) {
  const API_BASE = process.env.API_BASE; // e.g. https://url-matcher-70649262164.europe-west1.run.app
  if (!API_BASE) {
    return res.status(500).json({ error: 'API_BASE is not defined' });
  }

  // Construit l'URL amont en retirant le préfixe /api/proxy
  const upstreamPath = req.url.replace(/^\/api\/proxy/, '') || '/';
  const base = API_BASE.replace(/\/$/, '');
  const url = base + (upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`);

  // Copie d'en-têtes simples (éviter host/content-length)
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (!['host', 'content-length'].includes(key)) {
      headers[key] = v;
    }
  }

  const init = {
    method: req.method,
    headers,
    redirect: 'manual'
  };

  // Corps uniquement pour les méthodes avec body
  if (!['GET', 'HEAD'].includes(req.method)) {
    // Vercel fournit req comme stream — on le passe tel quel
    init.body = req;
  }

  try {
    const upstream = await fetch(url, init);

    // Re-propage (la plupart des) headers
    upstream.headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (!['content-encoding', 'transfer-encoding'].includes(lk)) {
        res.setHeader(key, value);
      }
    });

    res.status(upstream.status);

    // Corps binaire (buffer) pour couvrir JSON / texte / fichiers
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'Bad gateway', detail: e?.message || String(e) });
  }
}
