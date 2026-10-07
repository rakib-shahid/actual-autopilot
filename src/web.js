import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A small built-in web page: run status, "Scan now", the review list and recent
// log lines. No framework, one static HTML file plus a JSON API.

const MAX_BODY = 1024 * 1024;

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Optional HTTP basic auth: any username, password from WEB_PASSWORD.
function authorized(req, password) {
  if (!password) return true;
  const m = (req.headers.authorization ?? '').match(/^Basic (.+)$/);
  if (!m) return false;
  const given = Buffer.from(Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':'));
  const want = Buffer.from(password);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

export function startWebServer({ port, password, publicDir, api, log }) {
  const indexHtml = () => fs.readFileSync(path.join(publicDir, 'index.html'));

  const server = http.createServer(async (req, res) => {
    if (!authorized(req, password)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="actual-autopilot"' });
      return res.end('Password required');
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, indexHtml(), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, api.status());
      if (req.method === 'POST' && url.pathname === '/api/scan') {
        const started = api.scan();
        return send(res, started ? 202 : 409, { started, status: api.status() });
      }
      if (req.method === 'GET' && url.pathname === '/api/review') return send(res, 200, await api.review());
      if (req.method === 'GET' && url.pathname === '/api/recent') return send(res, 200, await api.recent());
      if (req.method === 'POST' && url.pathname === '/api/notes') {
        const body = await readJson(req);
        if (!Array.isArray(body.updates)) return send(res, 400, { error: 'updates must be an array' });
        return send(res, 200, await api.saveNotes(body.updates));
      }
      if (req.method === 'POST' && url.pathname === '/api/review') {
        const body = await readJson(req);
        if (!Array.isArray(body.decisions)) return send(res, 400, { error: 'decisions must be an array' });
        return send(res, 200, await api.decide(body.decisions));
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      log(`Web request ${req.method} ${url.pathname} failed:`, err?.message ?? err);
      send(res, 500, { error: err?.message ?? 'failed' });
    }
  });
  server.listen(port, () => log(`Web page on port ${port}${password ? ' (password protected)' : ''}`));
  return server;
}
