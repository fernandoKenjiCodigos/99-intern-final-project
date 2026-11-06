/**
 * API da réplica 99 Cross-User. Zero dependências: apenas node:http + fs.
 *
 *   node server/server.js [--port 4319]
 *
 * Rotas (JSON, prefixo /api):
 *   GET    /api/health
 *   GET    /api/segments
 *   GET    /api/rides/options
 *   POST   /api/sessions                       { segment }
 *   GET    /api/sessions/:id
 *   GET    /api/sessions/:id/popup              -> { due, remainingMs, creative, coupon }
 *   POST   /api/sessions/:id/ride              { optionIds: string[] }
 *   POST   /api/sessions/:id/popup/accept
 *   POST   /api/sessions/:id/popup/dismiss
 *   POST   /api/sessions/:id/food/open
 *   GET    /api/sessions/:id/food/items
 *   POST   /api/sessions/:id/orders            { itemId }
 *   POST   /api/sessions/:id/reset
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiError,
  createSession,
  readSession,
  confirmRide,
  popupStatus,
  acceptPopup,
  dismissPopup,
  openFood,
  listFoodItems,
  placeOrder,
  resetSession,
  optionPayload,
  segmentPayload,
} from './store.js';
import { ROUTE, POPUP_DELAY_MS } from './data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'body_too_large', 'Corpo da requisição excede 64 KB.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'invalid_body', 'O corpo deve ser um objeto JSON.');
    }
    return parsed;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, 'invalid_json', 'JSON inválido no corpo da requisição.');
  }
}

/** Tabela de rotas da API: [método, regex, handler]. */
const ROUTES = [
  ['GET', /^\/api\/health$/, (_req, res) => json(res, 200, { ok: true, popupDelayMs: POPUP_DELAY_MS })],
  ['GET', /^\/api\/segments$/, (_req, res) => json(res, 200, { segments: segmentPayload() })],
  [
    'GET',
    /^\/api\/rides\/options$/,
    (_req, res) =>
      json(res, 200, {
        route: ROUTE,
        options: optionPayload(),
        popupDelayMs: POPUP_DELAY_MS,
      }),
  ],
  [
    'POST',
    /^\/api\/sessions$/,
    async (req, res) => {
      const body = await readJsonBody(req);
      json(res, 201, createSession({ segment: body.segment }));
    },
  ],
  ['GET', /^\/api\/sessions\/([\w-]+)$/, (_req, res, [id]) => json(res, 200, readSession(id))],
  ['GET', /^\/api\/sessions\/([\w-]+)\/popup$/, (_req, res, [id]) => json(res, 200, popupStatus(id))],
  [
    'POST',
    /^\/api\/sessions\/([\w-]+)\/ride$/,
    async (req, res, [id]) => json(res, 200, confirmRide(id, await readJsonBody(req))),
  ],
  ['POST', /^\/api\/sessions\/([\w-]+)\/popup\/accept$/, (_req, res, [id]) => json(res, 200, acceptPopup(id))],
  ['POST', /^\/api\/sessions\/([\w-]+)\/popup\/dismiss$/, (_req, res, [id]) => json(res, 200, dismissPopup(id))],
  ['POST', /^\/api\/sessions\/([\w-]+)\/food\/open$/, (_req, res, [id]) => json(res, 200, openFood(id))],
  [
    'GET',
    /^\/api\/sessions\/([\w-]+)\/food\/items$/,
    (_req, res, [id]) => json(res, 200, listFoodItems(id)),
  ],
  [
    'POST',
    /^\/api\/sessions\/([\w-]+)\/orders$/,
    async (req, res, [id]) => json(res, 201, placeOrder(id, await readJsonBody(req))),
  ],
  ['POST', /^\/api\/sessions\/([\w-]+)\/reset$/, (_req, res, [id]) => json(res, 200, resetSession(id))],
];

function serveStatic(req, res) {
  // A checagem precisa usar o path CRU: `new URL()` normaliza `..` para esquemas
// http e apagaria o ataque antes de qualquer guard rodar.
const rawPath = (req.url ?? '/').split('?')[0].split('#')[0];

let pathname;
try {
  pathname = decodeURIComponent(rawPath);
} catch {
  // Percent-encoding inválido (ex.: %zz) não deve derrubar o processo.
  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('400');
  return;
}

// Rejeita `..` em qualquer forma: `/`, `\` ou encodado.
const escaped = pathname.split(/[\\/]+/).some((seg) => seg === '..');
if (escaped) {
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('403');
  return;
}

if (pathname.endsWith('/')) pathname += 'index.html';

// O Chrome pede /favicon.ico mesmo quando o HTML declara um SVG. Sem isto,
// o 404 vira ruído de console e polui qualquer teste que observe erros.
if (pathname === '/favicon.ico') {
  res.writeHead(302, { location: '/favicon.svg' });
  res.end();
  return;
}

const target = path.join(ROOT, path.normalize(pathname));
  if (!target.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': ['.html', '.js', '.css'].includes(ext) ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(target).pipe(res);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (!pathname.startsWith('/api')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: { code: 'method_not_allowed', message: 'Use GET para arquivos estáticos.' } });
        return;
      }
      serveStatic(req, res);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
      res.end();
      return;
    }

    for (const [method, pattern, handler] of ROUTES) {
      const match = pathname.match(pattern);
      if (!match) continue;
      if (method !== req.method) {
        json(res, 405, { error: { code: 'method_not_allowed', message: `Use ${method} em ${pathname}.` } });
        return;
      }
      try {
        await handler(req, res, match.slice(1));
      } catch (err) {
        handleError(res, err, pathname);
      }
      return;
    }

    json(res, 404, { error: { code: 'not_found', message: `Rota ${req.method} ${pathname} não existe.` } });
  });
}

function handleError(res, err, pathname) {
  if (err instanceof ApiError) {
    json(res, err.status, { error: { code: err.code, message: err.message } });
    return;
  }
  console.error(`[500] ${pathname}`, err);
  json(res, 500, { error: { code: 'internal_error', message: 'Erro interno no servidor.' } });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg > -1 ? Number(process.argv[portArg + 1]) : Number(process.env.PORT ?? 4319);
  createServer().listen(port, () => {
    console.log(`99 replica rodando em http://localhost:${port}`);
  });
}