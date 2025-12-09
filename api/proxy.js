export default async function handler(req, res) {
  const base = process.env.API_BASE || 'https://url-matcher-70649262164.europe-west1.run.app';
  const path = req.url.replace(/^\/api\/proxy/, '');
  const target = base.replace(/\/$/, '') + path;

  const init = {
    method: req.method,
    headers: { ...req.headers, host: undefined, 'content-length': undefined },
    body: ['GET','HEAD'].includes(req.method) ? undefined : req
  };

  const r = await fetch(target, init);
  const buf = Buffer.from(await r.arrayBuffer());
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');
  res.status(r.status).send(buf);
}
