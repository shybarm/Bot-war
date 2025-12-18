const ws = new WebSocket(`wss://${location.host}/ws/war-room`);

const botsEl = document.getElementById("bots");
const tradesEl = document.getElementById("trades");
const logEl = document.getElementById("combat-log");
const symbolEl = document.getElementById("active-symbol");

let chart, priceSeries;
let symbols = [];
let symbolIndex = 0;
let currentSymbol = null;

/* ---------------- WS STATUS ---------------- */
ws.onopen = () => {
  document.getElementById("ws-status").innerText = "WS: CONNECTED";
};

ws.onclose = () => {
  document.getElementById("ws-status").innerText = "WS: DISCONNECTED";
};

/* ---------------- WS MESSAGES ---------------- */
ws.onmessage = (e) => {
  const { type, payload } = JSON.parse(e.data);

  if (type === "symbols") symbols = payload;
  if (type === "portfolio") renderBots(payload);
  if (type === "trade") renderTrade(payload);
  if (type === "reasoning") renderLog(payload);
  if (type === "sentiment") updateChart(payload);
};

/* ---------------- BOT SCOREBOARD ---------------- */
function renderBots(snapshot) {
  botsEl.innerHTML = "";

  snapshot.bots
    .sort((a, b) => (b.cash + (snapshot.positions[b.strategy]?.length || 0)) -
                    (a.cash + (snapshot.positions[a.strategy]?.length || 0)))
    .forEach((b, i) => {
      const equity = b.cash;
      const progress = Math.min(100, (equity / 150000) * 100);

      const div = document.createElement("div");
      div.className = "bot-card";
      div.innerHTML = `
        <div class="bot-title">${i + 1}. ${b.strategy.toUpperCase()}</div>
        <div class="bot-meta">Equity: $${equity.toFixed(2)}</div>
        <div class="progress"><div class="progress-inner" style="width:${progress}%"></div></div>
      `;
      botsEl.appendChild(div);
    });
}

/* ---------------- TRADE LEDGER ---------------- */
function renderTrade(t) {
  const div = document.createElement("div");
  div.className = "trade";
  div.innerHTML = `
    <div class="${t.side === "BUY" ? "buy" : "sell"}">
      ${t.strategy.toUpperCase()} ${t.side} ${t.symbol}
    </div>
    <div>${t.qty.toFixed(4)} @ $${t.price.toFixed(2)}</div>
    <div style="opacity:.6">${t.note}</div>
  `;
  tradesEl.prepend(div);
}

/* ---------------- COMBAT LOG ---------------- */
function renderLog({ ts, strategy, rationale }) {
  const div = document.createElement("div");
  div.className = "log-line";
  div.innerText = `[${new Date(ts).toLocaleTimeString()}] ${strategy}: ${rationale}`;
  logEl.prepend(div);
}

/* ---------------- CHART ---------------- */
function initChart(symbol) {
  currentSymbol = symbol;
  symbolEl.innerText = `Symbol: ${symbol}`;

  document.getElementById("chart").innerHTML = "";
  chart = LightweightCharts.createChart(document.getElementById("chart"), {
    layout: { background: { color: "#0b0e19" }, textColor: "#9bb4ff" }
  });

  priceSeries = chart.addLineSeries({ color: "#9bb4ff", lineWidth: 2 });

  fetch(`/api/history/${symbol}`)
    .then(r => r.json())
    .then(j => j.ok && priceSeries.setData(j.data));
}

function updateChart({ symbol, price }) {
  if (symbol !== currentSymbol) return;
  priceSeries.update({ time: Date.now() / 1000, value: price });
}

/* ---------------- SYMBOL CAROUSEL ---------------- */
setInterval(() => {
  if (!symbols.length) return;
  symbolIndex = (symbolIndex + 1) % symbols.length;
  initChart(symbols[symbolIndex]);
}, 5000);
