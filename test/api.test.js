/**
 * Testes da API. Rodam contra um servidor real em porta efêmera.
 *   node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server/server.js';

let server;
let base;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function newSession(segment = 'churn') {
  const { data } = await call('/api/sessions', { method: 'POST', body: { segment } });
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ catálogo ------------------------------ */

test('health expõe o atraso do pop-up em 2000 ms', async () => {
  const { status, data } = await call('/api/health');
  assert.equal(status, 200);
  assert.equal(data.popupDelayMs, 2000);
});

test('segmentos têm criativos distintos', async () => {
  const { data } = await call('/api/segments');
  const byId = Object.fromEntries(data.segments.map((s) => [s.id, s]));
  assert.equal(byId.churn.creative.file, 'assets/popup-churn.webp');
  assert.equal(byId.novo.creative.file, 'assets/popup-novo.webp');
  assert.notEqual(byId.churn.coupon.kind, byId.novo.coupon.kind);
});

test('catálogo de corrida: só 99Pop e 99Plus são selecionáveis', async () => {
  const { data } = await call('/api/rides/options');
  const selectable = data.options.filter((o) => o.selectable).map((o) => o.id);
  assert.deepEqual(selectable.sort(), ['plus', 'pop']);
  assert.equal(data.options.find((o) => o.id === 'negocia').offer, true);
});

/* ------------------------------ fluxo ------------------------------ */

test('fluxo churn completo: corrida -> pop-up -> pedido -> hub', async () => {
  const s = await newSession('churn');
  assert.equal(s.state, 'ride-select', 'criar sessão já entra na tela 1');

  const ride = await call(`/api/sessions/${s.id}/ride`, {
    method: 'POST',
    body: { optionIds: ['pop', 'plus'] },
  });
  assert.equal(ride.status, 200);
  assert.equal(ride.data.state, 'tracking');
  // pop + plus com cupom de 8: 28,80 + (40,40 - 8,00)
  assert.equal(ride.data.ride.total, 61.2);

  const popup = await call(`/api/sessions/${s.id}/popup`);
  assert.equal(popup.data.creative.key, 'popup-churn');
  assert.ok(popup.data.remainingMs > 0, 'pop-up não pode vencer antes dos 2 s');

  await sleep(2150);
  const due = await call(`/api/sessions/${s.id}/popup`);
  assert.equal(due.data.due, true, 'após 2 s o servidor deve marcar due=true');

  const accepted = await call(`/api/sessions/${s.id}/popup/accept`, { method: 'POST' });
  assert.equal(accepted.data.state, 'food');
  assert.equal(accepted.data.couponUsed, true);

  const menu = await call(`/api/sessions/${s.id}/food/items`);
  const bigMac = menu.data.items.find((i) => i.id === 'big-mac');
  assert.equal(bigMac.couponPreview.applied, false, 'abaixo do mínimo de R$ 25 não aplica');

  const order = await call(`/api/sessions/${s.id}/orders`, {
    method: 'POST',
    body: { itemId: 'big-mac' },
  });
  assert.equal(order.status, 201);
  assert.equal(order.data.state, 'completed');
  assert.equal(order.data.order.total, 6.89); // 1,99 + 4,90, sem cupom
  assert.equal(order.data.order.discount, 0);

  const reset = await call(`/api/sessions/${s.id}/reset`, { method: 'POST' });
  assert.equal(reset.data.state, 'hub');
  assert.equal(reset.data.order, null);
});

test('fluxo novo: cupom de R$ 8 aplica no item elegível', async () => {
  const s = await newSession('novo');
  await call(`/api/sessions/${s.id}/ride`, { method: 'POST', body: { optionIds: ['pop'] } });
  await sleep(2150);
  await call(`/api/sessions/${s.id}/popup/accept`, { method: 'POST' });

  const menu = await call(`/api/sessions/${s.id}/food/items`);
  const duplo = menu.data.items.find((i) => i.id === 'chicken-duplo'); // 15,49
  assert.equal(duplo.couponPreview.applied, true);
  assert.equal(duplo.couponPreview.amount, 8);

  const order = await call(`/api/sessions/${s.id}/orders`, {
    method: 'POST',
    body: { itemId: 'chicken-duplo' },
  });
  assert.equal(order.data.order.discount, 8);
  assert.equal(order.data.order.total, 12.39); // 15,49 + 4,90 - 8,00
});

test('dispensar o pop-up abre o 99Food sem cupom', async () => {
  const s = await newSession('churn');
  await call(`/api/sessions/${s.id}/ride`, { method: 'POST', body: { optionIds: ['pop'] } });
  await sleep(2150);

  const dismissed = await call(`/api/sessions/${s.id}/popup/dismiss`, { method: 'POST' });
  assert.equal(dismissed.data.state, 'tracking');
  assert.equal(dismissed.data.popup.dismissed, true);

  const after = await call(`/api/sessions/${s.id}/popup`);
  assert.equal(after.data.due, false, 'pop-up dispensado não pode reaparecer');

  const food = await call(`/api/sessions/${s.id}/food/open`, { method: 'POST' });
  assert.equal(food.data.state, 'food');
  assert.equal(food.data.couponUsed, false);

  const menu = await call(`/api/sessions/${s.id}/food/items`);
  assert.equal(menu.data.couponActive, false);
});

/* ------------------------------ validação ------------------------------ */

test('confirmar sem seleção é 400', async () => {
  const s = await newSession('churn');
  const res = await call(`/api/sessions/${s.id}/ride`, { method: 'POST', body: { optionIds: [] } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'no_option_selected');
});

test('selecionar 99Táxi (não selecionável) é 400', async () => {
  const s = await newSession('churn');
  const res = await call(`/api/sessions/${s.id}/ride`, { method: 'POST', body: { optionIds: ['taxi'] } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'option_not_selectable');
});

test('aceitar pop-up antes de confirmar corrida é 409', async () => {
  const s = await newSession('churn');
  const res = await call(`/api/sessions/${s.id}/popup/accept`, { method: 'POST' });
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, 'invalid_transition');
});

test('pedido fora da tela de food é 409', async () => {
  const s = await newSession('churn');
  await call(`/api/sessions/${s.id}/ride`, { method: 'POST', body: { optionIds: ['pop'] } });
  const res = await call(`/api/sessions/${s.id}/orders`, {
    method: 'POST',
    body: { itemId: 'big-mac' },
  });
  assert.equal(res.status, 409);
});

test('segmento inexistente é 400', async () => {
  const res = await call('/api/sessions', { method: 'POST', body: { segment: 'inventado' } });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, 'unknown_segment');
});

test('sessão inexistente é 404', async () => {
  const res = await call('/api/sessions/nao-existe');
  assert.equal(res.status, 404);
});

test('JSON inválido é 400', async () => {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_json');
});

/** Envia o path literal, sem normalização do cliente. */
function rawGet(rawPath) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('path traversal é bloqueado (barra e contrabarra, cru e encodado)', async () => {
  // fetch() normaliza `../` antes de enviar, então só http.request exercita o guard.
  assert.equal(await rawGet('/../server/data.js'), 403);
  assert.equal(await rawGet('/..%2f..%2fpackage.json'), 403);
  assert.equal(await rawGet('/..%5c..%5cpackage.json'), 403);
  assert.equal(await rawGet('/%2e%2e%5c%2e%2e%5cpackage.json'), 403);
});

test('percent-encoding inválido responde 400 sem derrubar o servidor', async () => {
  assert.equal(await rawGet('/%zz'), 400);
  // O servidor precisa continuar vivo depois do erro.
  const { status } = await call('/api/health');
  assert.equal(status, 200);
});

test('index.html é servido na raiz', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});

test('favicon.ico redireciona para o SVG (sem 404 no console)', async () => {
  const res = await fetch(`${base}/favicon.ico`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/favicon.svg');

  const svg = await fetch(`${base}/favicon.svg`);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
});

test('assets .webp são servidos como image/webp', async () => {
  const res = await fetch(`${base}/assets/popup-churn.webp`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp');
});