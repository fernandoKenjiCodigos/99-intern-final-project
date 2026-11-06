/**
 * Catálogo do domínio da demo 99 Cross-User.
 * Números de preço/ETA seguem a tela de referência (Alameda Itu, 395 -> Liberdade, 10,7 km).
 */

/** Tempo entre chegar na tela de acompanhamento e o pop-up aparecer. */
export const POPUP_DELAY_MS = 2000;

export const SEGMENTS = {
  churn: {
    id: 'churn',
    label: 'Usuários churn',
    tagline: 'Já pediu no 99Food, mas não pede há 30+ dias',
    accent: 'dark',
    creativeKey: 'popup-churn',
    creativeFile: 'assets/popup-churn.webp',
    coupon: {
      kind: 'percent',
      value: 30,
      minSubtotal: 25,
      maxDiscount: 20,
      label: '30% OFF',
      headline: 'Sentimos sua falta',
      terms: 'Válido em pedidos acima de R$ 25 · desconto máximo de R$ 20 · válido por 7 dias.',
    },
  },
  novo: {
    id: 'novo',
    label: 'Novos usuários',
    tagline: 'Nunca pediu no 99Food · primeira experiência',
    accent: 'yellow',
    creativeKey: 'popup-novo',
    creativeFile: 'assets/popup-novo.webp',
    coupon: {
      kind: 'amount',
      value: 8,
      minSubtotal: 10,
      maxDiscount: 8,
      label: 'R$ 8 OFF',
      headline: 'Seu primeiro pedido chegou',
      terms: 'Válido em pedidos acima de R$ 10 · válido por 7 dias.',
    },
  },
};

/** Opções da tela 1. Só as marcadas como `selectable` respondem ao clique. */
export const RIDE_OPTIONS = [
  { id: 'pop', name: '99Pop', note: null, etaMin: 4, price: 28.8, selectable: true, defaultSelected: true, icon: 'car' },
  { id: 'plus', name: '99Plus', note: 'Melhores carros', etaMin: 4, price: 40.4, couponOff: 8, selectable: true, defaultSelected: true, icon: 'car-premium' },
  { id: 'taxi', name: '99Táxi', note: null, etaMin: 1, price: 52.8, approx: true, selectable: false, icon: 'taxi' },
  { id: 'taxi-top', name: '99Táxi Top', note: 'Melhores carros', etaMin: 2, price: 52.8, approx: true, selectable: false, icon: 'taxi-top' },
  { id: 'negocia', name: '99Negocia', note: 'Faça sua oferta', etaMin: null, price: 26.1, offer: true, selectable: false, icon: 'negotiate' },
];

export const ROUTE = {
  pickup: 'Alameda Itu, 395',
  pickupNote: 'Básico Materiais Para constr…',
  destination: 'Eldo Trade Center',
  destinationNote: 'Liberdade',
  distanceKm: 10.7,
  arrivalClock: '15:04',
  savingsHeadline: 'Economize até R$ 8,00 nesta corrida',
  passenger: 'Você',
  driver: { name: 'Marcos A.', rating: 4.9, car: 'Fiat Cronos · Prata', plate: 'FQZ-8C21' },
};

/** Tela do 99Food: uma imagem só. Os "+" são botões sobre ela, nas coordenadas em pixels da imagem. */
export const FOOD_SCREEN = { file: 'assets/chega-junto-tela.png', width: 284, height: 777 };

/** Pratos da imagem. `plus` é o centro do "+" amarelo, medido por análise de pixel. */
export const FOOD_ITEMS = [
  { id: 'cheddar', name: 'Cheddar Jr.', brand: 'Burger King', price: 10.99, plus: { x: 71.5, y: 498.5 } },
  { id: 'big-mac', name: 'Big Mac', brand: "McDonald's", price: 1.99, plus: { x: 165.5, y: 498.5 } },
  { id: 'brabissimo', name: 'Brabíssimo 1 Carne', brand: "McDonald's", price: 26.9, plus: { x: 259.5, y: 498.5 } },
  { id: 'kookaburra', name: 'Kookaburra Wings', brand: 'Outback', price: 19.99, plus: { x: 71.5, y: 708.5 } },
  { id: 'sanduiche-pop', name: 'Sanduíche Pop Nola Rosé', brand: "McDonald's", price: 12.9, plus: { x: 165.5, y: 708.5 } },
  { id: 'chicken-duplo', name: 'Chicken Duplo', brand: 'Burger King', price: 15.49, plus: { x: 259.5, y: 708.5 } },
];

export const DELIVERY_FEE = 4.9;

/**
 * Calcula o benefício do cupom do segmento.
 * Retorna sempre um valor exato, mesmo quando não aplicável.
 */
export function computeCoupon(coupon, subtotal) {
  if (subtotal < coupon.minSubtotal) {
    return {
      applied: false,
      amount: 0,
      reason: `Pedido mínimo de R$ ${coupon.minSubtotal.toFixed(2)} para usar o cupom`,
      couponLabel: coupon.label,
    };
  }
  const raw = coupon.kind === 'percent' ? (subtotal * coupon.value) / 100 : coupon.value;
  const amount = Math.min(round2(raw), coupon.maxDiscount ?? raw);
  return {
    applied: amount > 0,
    amount: round2(amount),
    reason: null,
    couponLabel: coupon.label,
    capped: coupon.kind === 'percent' && round2(raw) > (coupon.maxDiscount ?? Infinity),
  };
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function brl(n) {
  return `R$ ${n.toFixed(2).replace('.', ',')}`;
}
