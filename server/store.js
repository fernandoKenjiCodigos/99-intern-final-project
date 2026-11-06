/**
 * Máquina de estados da sessão. Toda a lógica de negócio vive aqui.
 * O servidor HTTP apenas valida entrada e delega.
 */
import { randomUUID } from 'node:crypto';
import {
  SEGMENTS,
  RIDE_OPTIONS,
  FOOD_SCREEN,
  FOOD_ITEMS,
  DELIVERY_FEE,
  POPUP_DELAY_MS,
  computeCoupon,
  round2,
  brl,
} from './data.js';

const STATES = ['hub', 'ride-select', 'tracking', 'food', 'completed'];

/** Transições permitidas. Qualquer outra é 409. */
const ALLOWED = {
  'confirm-ride': ['ride-select'],
  'accept-popup': ['tracking'],
  'dismiss-popup': ['tracking'],
  'open-food': ['tracking'],
  'place-order': ['food'],
  reset: ['completed', 'tracking', 'food', 'ride-select', 'hub'],
};

const MAX_EVENTS = 60;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sessions = new Map();

export function createSession({ segment }) {
  const seg = SEGMENTS[segment];
  if (!seg) throw new ApiError(400, 'unknown_segment', `Segmento '${segment}' não existe.`);

  const session = {
    id: randomUUID(),
    segmentId: segment,
    // Escolher o segmento já é entrar no fluxo: a tela 1 é a primeira do processo.
    state: 'ride-select',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ride: null,
    popup: null,
    couponUsed: false,
    order: null,
    events: [],
  };
  log(session, 'session:created', { segment });
  sessions.set(session.id, session);
  return view(session);
}

export function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new ApiError(404, 'session_not_found', 'Sessão não encontrada. Crie uma nova.');
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(id);
    throw new ApiError(410, 'session_expired', 'Sessão expirou. Crie uma nova.');
  }
  return s;
}

export function readSession(id) {
  return view(getSession(id));
}

function transition(session, action) {
  const allowed = ALLOWED[action] ?? [];
  if (!allowed.includes(session.state)) {
    throw new ApiError(
      409,
      'invalid_transition',
      `'${action}' não é válido em '${session.state}'. Esperado: ${allowed.join(', ')}.`
    );
  }
}

/* ------------------------------- ações ------------------------------- */

export function confirmRide(id, { optionIds } = {}) {
  const session = getSession(id);
  transition(session, 'confirm-ride');

  const ids = Array.isArray(optionIds) ? optionIds : [];
  if (ids.length === 0) throw new ApiError(400, 'no_option_selected', 'Selecione ao menos uma opção de corrida.');

  const selected = ids.map((optId) => {
    const opt = RIDE_OPTIONS.find((o) => o.id === optId);
    if (!opt) throw new ApiError(400, 'unknown_option', `Opção '${optId}' não existe.`);
    if (!opt.selectable) throw new ApiError(400, 'option_not_selectable', `'${opt.name}' não aceita seleção.`);
    return opt;
  });

  const unique = [...new Map(selected.map((o) => [o.id, o])).values()];
  const total = round2(unique.reduce((sum, o) => sum + o.price - (o.couponOff ?? 0), 0));

  session.ride = {
    optionIds: unique.map((o) => o.id),
    options: unique.map((o) => ({ id: o.id, name: o.name, price: o.price, couponOff: o.couponOff ?? 0 })),
    total,
    totalLabel: brl(total),
    confirmedAt: Date.now(),
  };
  session.state = 'tracking';
  // O relógio do pop-up começa no servidor: o cliente não decide quando ele aparece.
  session.popup = {
    dueAt: Date.now() + POPUP_DELAY_MS,
    shown: false,
    accepted: false,
    dismissed: false,
  };
  log(session, 'ride:confirmed', { options: session.ride.optionIds, total });
  return view(session);
}

/**
 * Avalia o pop-up no relógio do servidor.
 * `due` é a única fonte de verdade para o cliente decidir se abre o modal.
 */
export function popupStatus(id) {
  const session = getSession(id);
  const seg = SEGMENTS[session.segmentId];
  if (!session.popup) {
    return { due: false, remainingMs: null, available: false, creative: null, coupon: null };
  }
  const remainingMs = Math.max(0, session.popup.dueAt - Date.now());
  const due = remainingMs === 0 && !session.popup.accepted && !session.popup.dismissed;
  return {
    due,
    remainingMs,
    available: session.state === 'tracking',
    answered: session.popup.accepted || session.popup.dismissed,
    creative: { key: seg.creativeKey, file: seg.creativeFile, alt: `Pop-up ${seg.label}` },
    coupon: seg.coupon,
  };
}

export function acceptPopup(id) {
  const session = getSession(id);
  if (session.state === 'food' || session.state === 'completed') return view(session);
  transition(session, 'accept-popup');
  if (!session.popup) throw new ApiError(409, 'popup_unavailable', 'Nenhum pop-up ativo nesta sessão.');

  session.popup.accepted = true;
  session.popup.shown = true;
  session.couponUsed = true;
  session.state = 'food';
  log(session, 'popup:accepted', { coupon: SEGMENTS[session.segmentId].coupon.label });
  return view(session);
}

export function dismissPopup(id) {
  const session = getSession(id);
  if (session.state !== 'tracking' || !session.popup) {
    throw new ApiError(409, 'invalid_transition', `'dismiss-popup' não é válido em '${session.state}'.`);
  }
  session.popup.dismissed = true;
  session.popup.shown = true;
  log(session, 'popup:dismissed');
  return view(session);
}

/** Abre o 99Food sem cupom (usuário recusou o pop-up). */
export function openFood(id) {
  const session = getSession(id);
  transition(session, 'open-food');
  session.state = 'food';
  log(session, 'food:opened', { withCoupon: session.couponUsed });
  return view(session);
}

export function listFoodItems(id) {
  const session = getSession(id);
  const coupon = SEGMENTS[session.segmentId].coupon;
  return {
    screen: { ...FOOD_SCREEN, file: SEGMENTS[session.segmentId].foodFile },
    items: FOOD_ITEMS.map((it) => ({
      id: it.id,
      name: it.name,
      brand: it.brand,
      price: it.price,
      priceLabel: brl(it.price),
      plus: it.plus,
      couponPreview: session.couponUsed
        ? computeCoupon(coupon, it.price)
        : { applied: false, amount: 0, reason: 'Sem cupom nesta sessão', couponLabel: null },
    })),
    couponActive: session.couponUsed,
    coupon: session.couponUsed ? coupon : null,
  };
}

export function placeOrder(id, { itemId } = {}) {
  const session = getSession(id);
  transition(session, 'place-order');

  const item = FOOD_ITEMS.find((i) => i.id === itemId);
  if (!item) throw new ApiError(400, 'unknown_item', `Item '${itemId}' não existe no cardápio.`);

  const coupon = SEGMENTS[session.segmentId].coupon;
  const discount = session.couponUsed ? computeCoupon(coupon, item.price) : { applied: false, amount: 0, reason: null };
  const subtotal = item.price;
  const total = round2(subtotal + DELIVERY_FEE - discount.amount);

  session.order = {
    number: `99F-${String(Math.floor(Math.random() * 900000) + 100000)}`,
    restaurantName: item.brand,
    itemId,
    itemName: item.name,
    subtotal,
    subtotalLabel: brl(subtotal),
    deliveryFee: DELIVERY_FEE,
    deliveryFeeLabel: brl(DELIVERY_FEE),
    discount: discount.amount,
    discountLabel: brl(discount.amount),
    total,
    totalLabel: brl(total),
    couponLabel: discount.applied ? coupon.label : null,
    status: 'confirmed',
    eta: '25–35 min',
    createdAt: Date.now(),
  };
  session.state = 'completed';
  log(session, 'order:confirmed', { order: session.order.number, total });
  return view(session);
}

export function resetSession(id) {
  const session = getSession(id);
  transition(session, 'reset');
  session.state = 'hub';
  session.ride = null;
  session.popup = null;
  session.couponUsed = false;
  session.order = null;
  log(session, 'session:reset');
  return view(session);
}

/* ------------------------------ projeção ------------------------------ */

function log(session, type, detail = null) {
  session.updatedAt = Date.now();
  session.events.push({ at: new Date(session.updatedAt).toISOString(), type, detail });
  if (session.events.length > MAX_EVENTS) session.events.shift();
}

function view(session) {
  const seg = SEGMENTS[session.segmentId];
  return {
    id: session.id,
    segment: {
      id: seg.id,
      label: seg.label,
      tagline: seg.tagline,
      accent: seg.accent,
      coupon: seg.coupon,
      creative: { key: seg.creativeKey, file: seg.creativeFile },
    },
    state: session.state,
    states: STATES,
    ride: session.ride,
    popup: session.popup ? popupStatusFor(session) : null,
    couponUsed: session.couponUsed,
    order: session.order,
    events: session.events.slice(-12),
  };
}

function popupStatusFor(session) {
  const remainingMs = Math.max(0, session.popup.dueAt - Date.now());
  return {
    due: remainingMs === 0 && !session.popup.accepted && !session.popup.dismissed,
    remainingMs,
    delayMs: POPUP_DELAY_MS,
    accepted: session.popup.accepted,
    dismissed: session.popup.dismissed,
  };
}

export function optionPayload() {
  return RIDE_OPTIONS.map((o) => ({
    id: o.id,
    name: o.name,
    note: o.note,
    etaMin: o.etaMin,
    price: o.price,
    priceLabel: brl(o.price),
    couponOff: o.couponOff ?? null,
    couponOffLabel: o.couponOff ? brl(o.couponOff) : null,
    approx: Boolean(o.approx),
    offer: Boolean(o.offer),
    selectable: o.selectable,
    defaultSelected: Boolean(o.defaultSelected),
    icon: o.icon,
  }));
}

export function segmentPayload() {
  return Object.values(SEGMENTS).map((s) => ({
    id: s.id,
    label: s.label,
    tagline: s.tagline,
    accent: s.accent,
    coupon: s.coupon,
    creative: { key: s.creativeKey, file: s.creativeFile },
  }));
}