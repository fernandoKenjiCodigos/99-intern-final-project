/**
 * Teste de ponta a ponta no navegador real, via CDP.
 *
 *   node server/server.js --port 4319 &
 *   chrome --headless=new --remote-debugging-port=9333 about:blank &
 *   node test/e2e.mjs
 *
 * Valida o que só o navegador prova: o pop-up aparece SOZINHO após 2 s,
 * os hotspots do criativo caem no lugar e o fluxo fecha no hub.
 */
import fs from 'node:fs';
import path from 'node:path';

const APP = process.env.APP_URL ?? 'http://localhost:4319/';
const CDP = process.env.CDP_URL ?? 'http://127.0.0.1:9333';
const OUT = path.resolve('.tmp/e2e');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(label, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`;
  console.log(line);
  if (!ok) failures += 1;
}

const targets = await (await fetch(`${CDP}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('Nenhuma aba CDP disponível. O Chrome está com --remote-debugging-port?');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});

let id = 0;
const pending = new Map();
/** Exceções e erros de console reais, coletados por evento do CDP. */
const pageErrors = [];

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(d.exception?.description ?? d.text);
    return;
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    // A mensagem do console não traz a URL; sem ela o diagnóstico fica cego.
    const src = msg.params.entry.url ? ` (${msg.params.entry.url})` : '';
    pageErrors.push(msg.params.entry.text + src);
    return;
  }
  if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
    const r = msg.params.response;
    pageErrors.push(`HTTP ${r.status} ${r.url}`);
    return;
  }
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
};

function send(method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'evaluate falhou');
  return res.result.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false,
});

/* --------------------------------- fluxo --------------------------------- */

await send('Page.navigate', { url: APP });
await wait(900);

check('menu abriu com os dois perfis', await evaluate("document.querySelectorAll('[data-segment]').length === 4"));

// Instrumenta a medição do atraso ANTES de qualquer clique.
await evaluate(`
  (() => {
    window.__t = {};
    const ov = document.querySelector('#overlay');
    new MutationObserver(() => {
      if (!ov.hidden && !window.__t.shown) window.__t.shown = performance.now();
    }).observe(ov, { attributes: true, attributeFilter: ['hidden'] });
    return true;
  })()
`);

await evaluate("document.querySelector('.sidebar .seg-churn').click(); true");
await wait(700);

const ride = await evaluate(`
  (() => ({
    visivel: !document.querySelector('#view-ride').hidden,
    selecionados: [...document.querySelectorAll('.opt.sel')].map(e => e.dataset.option),
    travados: [...document.querySelectorAll('.opt[disabled]')].map(e => e.dataset.option),
    confirmarHabilitado: !document.querySelector('#confirmBtn').disabled,
    resumo: document.querySelector('#confirmSummary').textContent.trim()
  }))()
`);
check('tela 1 é a de seleção de corrida', ride.visivel);
check('99Pop e 99Plus vêm pré-selecionados', ride.selecionados.join(',') === 'pop,plus', ride.selecionados.join(','));
check('99Táxi, Top e Negocia ficam travados', ride.travados.length === 3, ride.travados.join(','));
check('resumo de preço correto', ride.resumo === '99Pop + 99Plus · R$ 61,20', ride.resumo);
await shot('01-tela1');

// Confirmar e medir o pop-up.
await evaluate("(() => { window.__t.confirm = performance.now(); document.querySelector('#confirmBtn').click(); return true; })()");
await wait(260);
check('confirmar leva para a tela 2', await evaluate("!document.querySelector('#view-track').hidden"));
await shot('02-tela2-antes-do-popup');

await wait(3200);
const delta = await evaluate('Math.round(window.__t.shown - window.__t.confirm)');
check('pop-up abriu sozinho', Number.isFinite(delta), `${delta}ms`);
check('pop-up respeitou os 2 s (janela 1950–2400 ms)', delta >= 1950 && delta <= 2400, `${delta}ms`);
await shot('03-popup-churn');

const geo = await evaluate(`
  (() => {
    const img = document.querySelector('#popupImg').getBoundingClientRect();
    const cta = document.querySelector('#popupCta').getBoundingClientRect();
    const p = (v, base, off) => Math.round(((v - off) / base) * 10000) / 100;
    return {
      src: document.querySelector('#popupImg').getAttribute('src'),
      carregou: document.querySelector('#popupImg').naturalWidth > 0,
      ctaLeft: p(cta.left, img.width, img.left),
      ctaTop: p(cta.top, img.height, img.top),
      ctaW: p(cta.width, img.width, 0)
    };
  })()
`);
check('criativo de churn carregado', geo.carregou && geo.src.includes('popup-churn'), geo.src);
check(
  'hotspot do CTA alinhado à arte',
  Math.abs(geo.ctaLeft - 11.97) < 0.6 && Math.abs(geo.ctaTop - 88.4) < 0.6 && Math.abs(geo.ctaW - 75.97) < 0.6,
  `left=${geo.ctaLeft} top=${geo.ctaTop} w=${geo.ctaW}`
);

// Aceitar o pop-up -> 99Food com cupom.
await evaluate("document.querySelector('#popupCta').click(); true");
await wait(1000);
const food = await evaluate(`
  (() => ({
    visivel: !document.querySelector('#view-food').hidden,
    botoesMais: document.querySelectorAll('.food-plus').length,
    rotuloPrimeiro: document.querySelector('.food-plus')?.getAttribute('aria-label') ?? ''
  }))()
`);
check('CTA do pop-up abre o 99Food', food.visivel);
check('seis "+" sobre o cardápio', food.botoesMais === 6, `${food.botoesMais}/6`);
check('o "+" tem rótulo acessível', food.rotuloPrimeiro.startsWith('Adicionar'), food.rotuloPrimeiro);
await shot('04-99food');

// Clicar fora dos "+" (na imagem, entre eles) não pede nada.
await evaluate(`
  (() => {
    const r = document.querySelector('#foodImg').getBoundingClientRect();
    const x = r.left + r.width * 0.5;
    const y = r.top + r.height * 0.6;
    document.elementFromPoint(x, y)?.click();
    return true;
  })()
`);
await wait(400);
check(
  'clicar fora de um "+" não pede nada',
  await evaluate("document.querySelector('#orderOverlay').hidden"),
  'sem pedido acidental'
);

// Pedir pelo "+" do Big Mac e conferir o recibo (1,99 + 4,90, sem cupom).
await evaluate("document.querySelector('.food-plus[data-item=\"big-mac\"]').click(); true");
await wait(700);
const order = await evaluate(`
  (() => {
    const o = !document.querySelector('#orderOverlay').hidden;
    const txt = document.querySelector('#receipt').textContent.replace(/\\s+/g, ' ').trim();
    return { overlay: o, txt };
  })()
`);
check('"pedido confirmado" aparece', order.overlay);
check('recibo fecha em R$ 6,89', order.txt.includes('TotalR$ 6,89'), order.txt);
await shot('05-pedido-confirmado');


// Voltar ao menu.
await evaluate("document.querySelector('#orderDone').click(); true");
await wait(900);
const back = await evaluate("(() => ({ hub: !document.querySelector('#view-hub').hidden, sessao: document.querySelector('#apiSession').textContent.trim() }))()");
check('volta para o primeiro menu', back.hub);
await shot('06-de-volta-ao-menu');

// Fluxo completo do outro segmento, com o outro pop-up.
await evaluate("document.querySelector('.hub-card--novo').click(); true");
await wait(800);
await evaluate("document.querySelector('#confirmBtn').click(); true");
await wait(3400);
const novo = await evaluate(`
  (() => ({
    src: document.querySelector('#popupImg').getAttribute('src'),
    aberto: !document.querySelector('#overlay').hidden
  }))()
`);
check('novos usuários usa o outro pop-up', novo.aberto && novo.src.includes('popup-novo'), novo.src);
await shot('07-popup-novo');

await evaluate("document.querySelector('#popupCta').click(); true");
await wait(1000);
await evaluate("document.querySelector('.food-plus[data-item=\"chicken-duplo\"]').click(); true");
await wait(700);
const novoRecibo = await evaluate("document.querySelector('#receipt').textContent.replace(/\\s+/g, ' ').trim()");
check('recibo de novo usuário com R$ 8 OFF e total R$ 12,39', novoRecibo.includes('R$ 8,00') && novoRecibo.includes('TotalR$ 12,39'), novoRecibo);

await shot('08-novo-confirmado');

// Nenhuma exceção nem erro de console durante todo o percurso.
check(
  'nenhum erro de JS no console',
  pageErrors.length === 0,
  pageErrors.length ? pageErrors.join(' | ') : ''
);

ws.close();
console.log(`\n${failures === 0 ? 'E2E OK' : `E2E FALHOU (${failures})`} — prints em ${OUT}`);
process.exit(failures === 0 ? 0 : 1);