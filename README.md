# 99 · Réplica Cross-User

Réplica do processo Mobility → Food da 99, com API local. Zero dependências:
só `node:http`, `node:fs` e módulos nativos.

```bash
npm start            # http://localhost:4319
npm test             # 18 testes da API
```

## O processo replicado

1. **Menu** com dois perfis: `Usuários churn` e `Novos usuários`.
2. **Tela 1 — seleção de corrida.** Cinco opções; `99Pop` e `99Plus` são
   selecionáveis e vêm marcadas, as outras três ficam travadas (é o que a tela
   original mostra). O botão `Confirmar` só habilita com ao menos uma marcada.
3. **Tela 2 — acompanhamento.** O relógio de **2 s** começa no servidor no
   instante do `Confirmar`. Quando vence, o pop-up abre.
4. **Pop-up.** Criativo diferente por segmento: `popup-churn.webp` ou
   `popup-novo.webp`. Aceitar leva ao 99Food com o cupom do segmento.
5. **99Food.** Cada prato tem um **"+"** — o único alvo clicável do item.
   Clicar nele mostra `Pedido confirmado!` com o recibo e devolve o usuário
   ao menu inicial.

O relógio do pop-up roda no **servidor** (`popupDelayMs: 2000`), não num
`setTimeout` do cliente: recarregar a página no meio do caminho não adianta
o pop-up.

## API

Sessão nasce já em `ride-select`. Transições fora da ordem devolvem **409**.

| Método | Rota | Efeito |
|---|---|---|
| GET | `/api/health` | `popupDelayMs` |
| GET | `/api/segments` | perfis, cupons e criativos |
| GET | `/api/rides/options` | rota e opções de corrida |
| POST | `/api/sessions` | cria sessão `{ segment }` |
| GET | `/api/sessions/:id` | estado atual |
| GET | `/api/sessions/:id/popup` | `{ due, remainingMs, creative, coupon }` |
| POST | `/api/sessions/:id/ride` | `{ optionIds }` → `tracking` |
| POST | `/api/sessions/:id/popup/accept` | → `food` com cupom |
| POST | `/api/sessions/:id/popup/dismiss` | recusa, segue em `tracking` |
| POST | `/api/sessions/:id/food/open` | → `food` sem cupom |
| GET | `/api/sessions/:id/food/items` | seis pratos com prévia do cupom |
| POST | `/api/sessions/:id/orders` | `{ itemId }` → `completed` |
| POST | `/api/sessions/:id/reset` | volta ao menu |

Estados: `ride-select → tracking → food → completed → (reset)`.

## Cupons

| Segmento | Regra | Exemplo |
|---|---|---|
| churn | 30% com mínimo R$ 25, teto R$ 20 | R$ 26,90 → −R$ 8,07 |
| novo | R$ 8 fixo acima de R$ 10 | R$ 21,90 → −R$ 8,00 |

A conta é feita na API (`computeCoupon`), nunca no cliente. Frete fixo R$ 4,90.

## Teste de ponta a ponta

Precisa do servidor no ar e de um Chrome com CDP:

```bash
node server/server.js --port 4319 &
chrome --headless=new --remote-debugging-port=9333 about:blank &
npm run test:e2e
```

23 verificações no navegador real: pop-up abrindo sozinho dentro da janela de
2 s, hotspot do CTA alinhado ao criativo, o "+" presente e acessível em todos
os pratos, clicar no nome do prato não pedindo nada, cupons nas duas pontas e
ausência de erros de console **e** de respostas HTTP ≥ 400. Prints em `.tmp/e2e/`.

O detector de erros foi validado nos dois sentidos: falha quando se injeta um
404 real e passa quando a navegação está limpa.

## Arte

`assets/` foi recuperado de `99-popup-demo-standalone.html` (imagens em base64,
deduplicadas). Dimensões: app 708×1536, pop-ups 1086×1448.

O hotspot do CTA foi medido por análise de pixel na arte, não estimado:
`left 11,97% · top 88,4% · width 75,97%`, e o "X" em `85,5% / 8,09%`.

## Estrutura

```
index.html        menu, três telas e os dois overlays
styles.css        visual
app.js            cliente: só render, estado vem da API
favicon.svg       ícone da aba (o Chrome pede /favicon.ico, servido por 302)
server/data.js    catálogo, cupons e cálculo de desconto
server/store.js   máquina de estados da sessão
server/server.js  roteador HTTP + estáticos
test/api.test.js  18 testes da API
test/e2e.mjs      fluxo completo no navegador via CDP (23 verificações)
```

Réplica visual para demonstração. Sem afiliação oficial com a 99.