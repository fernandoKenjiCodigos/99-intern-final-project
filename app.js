/**
 * Cliente da réplica. Toda decisão de estado vem da API — aqui só há render.
 * O relógio do pop-up também é do servidor: o cliente consulta /popup.
 */

const API = '/api';

const ICONS = {
  car: '🚗',
  'car-premium': '🚙',
  taxi: '🚕',
  'taxi-top': '🚖',
  negotiate: '🤝',
};

const el = (id) => document.getElementById(id);

/** Lado, em pixels da imagem, da área clicável de cada "+". */
const PLUS_HIT = 30;

const dom = {
  screen: el('screen'),
  views: {
    hub: el('view-hub'),
    ride: el('view-ride'),
    track: el('view-track'),
    food: el('view-food'),
  },
  timeline: el('timeline'),
  apiBase: el('apiBase'),
  apiSession: el('apiSession'),
  apiPopup: el('apiPopup'),
  resetBtn: el('resetBtn'),
  optionsList: el('optionsList'),
  confirmBtn: el('confirmBtn'),
  confirmSummary: el('confirmSummary'),
  trackSummary: el('trackSummary'),
  trackPopupHint: el('trackPopupHint'),
  foodImg: el('foodImg'),
  foodPlusLayer: el('foodPlusLayer'),
  overlay: el('overlay'),
  popupImg: el('popupImg'),
  popupClose: el('popupClose'),
  popupCta: el('popupCta'),
  orderOverlay: el('orderOverlay'),
  receipt: el('receipt'),
  confirmedRestaurant: el('confirmedRestaurant'),
  orderDone: el('orderDone'),
  toast: el('toast'),
};

const state = {
  session: null,
  rideCatalog: null,
  selected: new Set(),
  foodItems: null,
  pollTimer: null,
  toastTimer: null,
  busy: false,
};

const TIMELINE_STEPS = [
  { id: 'hub', label: 'Escolha do perfil' },
  { id: 'ride-select', label: 'Seleção da corrida' },
  { id: 'tracking', label: 'Acompanhamento' },
  { id: 'popup', label: 'Pop-up 99Food' },
  { id: 'food', label: '99Food aberto' },
  { id: 'completed', label: 'Pedido confirmado' },
];

/* ------------------------------- HTTP ------------------------------- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data?.error?.message ?? `HTTP ${res.status}`);
    err.code = data?.error?.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ------------------------------ helpers ------------------------------ */

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    dom.toast.hidden = true;
  }, 2800);
}

function showView(name) {
  for (const [key, node] of Object.entries(dom.views)) {
    node.hidden = key !== name;
  }
}

function money(n) {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}

/* ------------------------------ sessão ------------------------------ */

async function startSession(segment) {
  state.session = await api('/sessions', { method: 'POST', body: { segment } });
  state.foodItems = null;
  state.selected.clear();
  if (!state.rideCatalog) state.rideCatalog = await api('/rides/options');
  resetSelectionsToDefault();
  render();
}

function resetSelectionsToDefault() {
  state.selected.clear();
  for (const opt of state.rideCatalog.options) {
    if (opt.defaultSelected) state.selected.add(opt.id);
  }
}

async function refreshSession() {
  if (!state.session) return;
  state.session = await api(`/sessions/${state.session.id}`);
  render();
}

/* ---------------------------- render geral ---------------------------- */

function render() {
  const s = state.session;
  dom.apiBase.textContent = API;
  dom.apiSession.textContent = s ? s.id.slice(0, 8) : '—';
  dom.apiPopup.textContent = s?.popup
    ? s.popup.due
      ? 'pronto'
      : `${Math.ceil(s.popup.remainingMs / 100) / 10}s`
    : '—';

  for (const btn of document.querySelectorAll('.seg-btn')) {
    btn.classList.toggle('on', s?.segment.id === btn.dataset.segment);
  }

  renderTimeline();
  if (!s) return;

  switch (s.state) {
    case 'hub':
      showView('hub');
      break;
    case 'ride-select':
      showView('ride');
      renderRide();
      break;
    case 'tracking':
      showView('track');
      renderTracking();
      startPopupPolling();
      break;
    case 'food':
      showView('food');
      loadFoodItems();
      break;
    case 'completed':
      renderCompleted();
      break;
  }
}

function renderTimeline() {
  const s = state.session;
  const current = s ? s.state : null;
  const ids = TIMELINE_STEPS.map((step) => step.id);

  let reached = current ? ids.indexOf(current) : -1;
  if (reached < 0) reached = 0;
  if (current === 'completed') reached = ids.length;

  dom.timeline.innerHTML = TIMELINE_STEPS.map((step, i) => {
    let cls = '';
    if (s) {
      if (i < reached) cls = 'done';
      else if (i === reached) cls = 'now';
    }
    return `<li class="${cls}"><span class="bullet">✓</span>${step.label}</li>`;
  }).join('');
}

/* ------------------------------ hub ------------------------------ */

/** Controles decorativos da réplica: desabilitados para não prometer ação. */
function wireDecorControls() {
  const decor = document.querySelectorAll('.link-btn, .driver-actions button');
  for (const node of decor) {
    node.setAttribute('aria-disabled', 'true');
    if (node.tagName === 'BUTTON') node.disabled = true;
  }
}

/* --------------------------- tela 1 · corrida --------------------------- */

function renderRide() {
  const { options, route } = state.rideCatalog;
  el('routePickup').textContent = route.pickup;
  el('routePickupNote').textContent = route.pickupNote;
  el('routeDest').textContent = route.destination;
  el('routeDestNote').textContent = route.destinationNote;
  el('mapEta').textContent = route.arrivalClock;
  el('mapKm').textContent = `(${route.distanceKm.toFixed(1).replace('.', ',')} km)`;

  dom.optionsList.innerHTML = options
    .map((opt) => {
      const selected = state.selected.has(opt.id);
      const cutPrice = opt.couponOff ? opt.price - opt.couponOff : null;

      const priceBlock = opt.offer
        ? `<div class="opt-step">
             <button type="button" aria-label="Diminuir oferta" data-offer="-">−</button>
             <span>${money(opt.price)}</span>
             <button type="button" aria-label="Aumentar oferta" data-offer="+">+</button>
           </div>`
        : cutPrice
          ? `<div class="opt-price">
               <span class="was">${opt.priceLabel}</span>
               <span class="now cut">${money(cutPrice)}</span>
             </div>`
          : `<div class="opt-price">
               <span class="now ${opt.selectable ? '' : 'locked'}">${opt.priceLabel}</span>
               ${opt.approx ? '<span class="approx">aprox.</span>' : ''}
             </div>`;

      const check = opt.selectable
        ? `<span class="opt-check" aria-hidden="true"></span>`
        : `<span class="opt-lock" aria-hidden="true">🔒</span>`;

      return `
        <button class="opt ${selected ? 'sel' : ''} ${opt.selectable ? '' : 'lock'}"
                type="button"
                data-option="${opt.id}"
                ${opt.selectable ? '' : 'disabled'}
                aria-pressed="${selected}">
          ${cutPrice ? '<span class="opt-badge">cupom</span>' : ''}
          <span class="opt-icon">${ICONS[opt.icon] ?? '🚗'}</span>
          <span class="opt-body">
            <span class="opt-name">${opt.name}</span>
            ${opt.note ? `<span class="opt-note">${opt.note}</span>` : ''}
            ${opt.etaMin ? `<span class="opt-eta">${opt.etaMin} min</span>` : ''}
          </span>
          ${priceBlock}
          ${check}
        </button>`;
    })
    .join('');

  updateConfirm();
}

function updateConfirm() {
  const options = state.rideCatalog?.options ?? [];
  const chosen = options.filter((o) => state.selected.has(o.id));
  dom.confirmBtn.disabled = chosen.length === 0;

  if (chosen.length === 0) {
    dom.confirmSummary.textContent = 'Selecione uma opção';
    return;
  }
  const total = chosen.reduce((sum, o) => sum + o.price - (o.couponOff ?? 0), 0);
  dom.confirmSummary.textContent = `${chosen.map((o) => o.name).join(' + ')} · ${money(total)}`;
}

function toggleOption(id) {
  const opt = state.rideCatalog.options.find((o) => o.id === id);
  if (!opt?.selectable) return;
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  renderRide();
}

async function confirmRide() {
  if (!state.session || state.selected.size === 0 || state.busy) return;
  state.busy = true;
  dom.confirmBtn.disabled = true;
  try {
    const sessionId = state.session.id;
    await api(`/sessions/${sessionId}/ride`, {
      method: 'POST',
      body: { optionIds: [...state.selected] },
    });
    // Redireciona mesmo que o refresh falhe: o estado já mudou no servidor.
    showView('track');
    await refreshSession();
  } catch (err) {
    showToast(err.message);
    dom.confirmBtn.disabled = false;
  } finally {
    state.busy = false;
  }
}

/* -------------------------- tela 2 · acompanhamento -------------------------- */

function renderTracking() {
  const s = state.session;
  const ride = s.ride;
  dom.trackSummary.innerHTML = `
    <div class="sum-chip"><span>Opção</span><strong>${ride.options.map((o) => o.name).join(' + ')}</strong></div>
    <div class="sum-chip"><span>Total</span><strong>${ride.totalLabel}</strong></div>`;

  dom.trackPopupHint.textContent = s.popup?.accepted
    ? 'Oferta aceita · abrindo o 99Food'
    : s.popup?.dismissed
      ? 'Oferta dispensada · toque para abrir o 99Food'
      : 'Um aviso vai aparecer em instantes…';
}

function stopPopupPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/**
 * O servidor decide quando o pop-up vence. O cliente pergunta a cada 250 ms
 * e abre quando `due` for verdadeiro — sem timer local concorrente.
 */
function startPopupPolling() {
  stopPopupPolling();
  if (state.session.state !== 'tracking') return;
  // Pop-up já respondido (aceito/dispensado): não há o que esperar.
  if (state.session.popup?.accepted || state.session.popup?.dismissed) return;

  const tick = async () => {
    if (!state.session || state.session.state !== 'tracking') {
      stopPopupPolling();
      return;
    }
    if (!dom.overlay.hidden) return;
    try {
      const status = await api(`/sessions/${state.session.id}/popup`);
      dom.apiPopup.textContent = status.due ? 'pronto' : `${Math.max(0, status.remainingMs) / 1000}s`;
      if (status.due) {
        openPopup(status);
        stopPopupPolling();
      }
    } catch (err) {
      if (err.status === 404 || err.status === 410) {
        stopPopupPolling();
        showToast('Sessão expirou. Escolha o perfil novamente.');
      }
    }
  };

  tick();
  state.pollTimer = setInterval(tick, 250);
}

function openPopup(status) {
  const creative = status.creative;
  dom.popupImg.src = creative.file;
  dom.popupImg.alt = creative.alt;
  dom.overlay.hidden = false;
  dom.overlay.dataset.segment = state.session.segment.id;
  // Foco no CTA: o pop-up nunca abre sem ação possível.
  requestAnimationFrame(() => dom.popupCta.focus({ preventScroll: true }));
}

function closePopup() {
  dom.overlay.hidden = true;
}

async function acceptPopup() {
  if (!state.session || state.busy) return;
  state.busy = true;
  try {
    closePopup();
    showToast(`Cupom ${state.session.segment.coupon.label} aplicado no seu pedido`);
    await api(`/sessions/${state.session.id}/popup/accept`, { method: 'POST' });
    await refreshSession();
  } catch (err) {
    showToast(err.message);
  } finally {
    state.busy = false;
  }
}

async function dismissPopup() {
  if (!state.session || state.busy) return;
  state.busy = true;
  try {
    closePopup();
    await api(`/sessions/${state.session.id}/popup/dismiss`, { method: 'POST' });
    await refreshSession();
    renderTracking();
  } catch (err) {
    showToast(err.message);
  } finally {
    state.busy = false;
  }
}

async function openFoodWithoutCoupon() {
  if (!state.session || state.busy) return;
  state.busy = true;
  try {
    await api(`/sessions/${state.session.id}/food/open`, { method: 'POST' });
    await refreshSession();
  } catch (err) {
    showToast(err.message);
  } finally {
    state.busy = false;
  }
}

/* ------------------------------ tela 3 · food ------------------------------ */

async function loadFoodItems() {
  if (!state.session) return;
  if (state.foodItems?.sessionId === state.session.id) return;
  state.foodItems = null;

  try {
    const data = await api(`/sessions/${state.session.id}/food/items`);
    state.foodItems = { ...data, sessionId: state.session.id };
    renderFood();
  } catch (err) {
    showToast(err.message);
  }
}

function renderFood() {
  const data = state.foodItems;
  if (!data) return;
  if (dom.foodImg.getAttribute('src') !== data.screen.file) {
    dom.foodImg.src = data.screen.file;
  }
  dom.foodPlusLayer.innerHTML = data.items
    .map(
      (it) => `<button class="food-plus" type="button" data-item="${it.id}"
                 style="left:${((it.plus.x - PLUS_HIT / 2) / data.screen.width) * 100}%;
                        top:${((it.plus.y - PLUS_HIT / 2) / data.screen.height) * 100}%;
                        width:${(PLUS_HIT / data.screen.width) * 100}%;
                        height:${(PLUS_HIT / data.screen.height) * 100}%"
                 aria-label="Adicionar ${it.name} ao pedido"></button>`
    )
    .join('');
}

async function placeOrder(itemId) {
  if (!state.session || state.busy) return;
  state.busy = true;
  try {
    const session = await api(`/sessions/${state.session.id}/orders`, {
      method: 'POST',
      body: { itemId },
    });
    state.session = session;
    state.foodItems = null;
    renderCompleted();
  } catch (err) {
    showToast(err.message);
  } finally {
    state.busy = false;
  }
}

/* ------------------------- pedido confirmado ------------------------- */

function renderCompleted() {
  const order = state.session.order;
  if (!order) return;

  dom.confirmedRestaurant.textContent = `${order.restaurantName} · ${order.itemName}`;
  dom.receipt.innerHTML = `
    <div class="receipt-row"><span>Pedido</span><b>${order.number}</b></div>
    <div class="receipt-row"><span>Subtotal</span><b>${order.subtotalLabel}</b></div>
    <div class="receipt-row"><span>Entrega</span><b>${order.deliveryFeeLabel}</b></div>
    ${
      order.discount > 0
        ? `<div class="receipt-row discount"><span>Cupom ${order.couponLabel}</span><b>− ${order.discountLabel}</b></div>`
        : ''
    }
    <div class="receipt-row total"><span>Total</span><b>${order.totalLabel}</b></div>
    <div class="receipt-row"><span>Previsão</span><b>${order.eta}</b></div>`;

  dom.orderOverlay.hidden = false;
}

async function backToHub() {
  if (!state.session || state.busy) return;
  state.busy = true;
  try {
    dom.orderOverlay.hidden = true;
    await api(`/sessions/${state.session.id}/reset`, { method: 'POST' });
    state.session = null;
    state.foodItems = null;
    state.selected.clear();
    stopPopupPolling();
    for (const node of Object.values(dom.views)) node.hidden = true;
    dom.views.hub.hidden = false;
    dom.timeline.innerHTML = '';
    dom.apiSession.textContent = '—';
    dom.apiPopup.textContent = '—';
    for (const btn of document.querySelectorAll('.seg-btn')) btn.classList.remove('on');
    showToast('Fluxo reiniciado');
  } catch (err) {
    showToast(err.message);
  } finally {
    state.busy = false;
  }
}

/* ------------------------------ eventos ------------------------------ */

for (const btn of document.querySelectorAll('[data-segment]')) {
  btn.addEventListener('click', async () => {
    if (state.busy) return;
    state.busy = true;
    stopPopupPolling();
    closePopup();
    dom.orderOverlay.hidden = true;
    try {
      await startSession(btn.dataset.segment);
    } catch (err) {
      showToast(err.message);
    } finally {
      state.busy = false;
    }
  });
}

dom.optionsList.addEventListener('click', (e) => {
  const offerBtn = e.target.closest('[data-offer]');
  if (offerBtn) {
    showToast('Oferta do 99Negocia não está habilitada nesta demo');
    return;
  }
  const btn = e.target.closest('[data-option]');
  if (btn) toggleOption(btn.dataset.option);
});

dom.confirmBtn.addEventListener('click', confirmRide);
el('rideBack').addEventListener('click', backToHub);
el('trackBack').addEventListener('click', backToHub);

dom.popupCta.addEventListener('click', acceptPopup);
dom.popupClose.addEventListener('click', dismissPopup);
dom.overlay.addEventListener('click', (e) => {
  if (e.target === dom.overlay) dismissPopup();
});

dom.orderDone.addEventListener('click', backToHub);

dom.foodPlusLayer.addEventListener('click', (e) => {
  const btn = e.target.closest('.food-plus[data-item]');
  if (btn) placeOrder(btn.dataset.item);
});

const trackFoodCard = el('trackFoodCard');
trackFoodCard.addEventListener('click', openFoodWithoutCoupon);
trackFoodCard.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openFoodWithoutCoupon();
  }
});

dom.resetBtn.addEventListener('click', () => {
  if (state.session) {
    backToHub();
    return;
  }
  for (const node of Object.values(dom.views)) node.hidden = true;
  dom.views.hub.hidden = false;
  dom.timeline.innerHTML = '';
  for (const btn of document.querySelectorAll('.seg-btn')) btn.classList.remove('on');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!dom.overlay.hidden) dismissPopup();
});

/* ------------------------------ boot ------------------------------ */

dom.views.hub.hidden = false;
showView('hub');
wireDecorControls();

// Pré-carrega o catálogo de corrida para a tela 1 montar instantânea.
try {
  state.rideCatalog = await api('/rides/options');
} catch {
  showToast('Falha ao carregar o catálogo. O servidor está rodando?');
}