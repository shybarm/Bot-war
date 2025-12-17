// ===================================
//  WAR ROOM REAL-TIME CLIENT
// ===================================

const ws = new WebSocket(`wss://${location.host}/ws/war-room`);

let chart, candleSeries, sentimentSeries;
let carouselSymbols = [];
let currentSymbolIndex = 0;
let currentSymbol = null;
const chartEl = document.getElementById("chart");
const logEl = document.getElementById("log");
const tradesPanel = document.getElementById("trades-panel");
const botsPanel = document.getElementById("bots-panel");

// WS CONNECTION STATUS
ws.onopen = () => {
  document.getElementById("ws-status").innerText = "WS: CONNECTED";
  document.getElementById("ws-status").style.background = "rgba(0,255,170,0.1)";
};

// WS ERROR + CLOSE
ws.onclose = () => {
  document.getElementById("ws-status").innerText = "WS: DISCONNECTED";
  document.getElementById("ws-status").style.background = "rgba(255,80,110,0.2)";
};

// MAIN WS MESSAGE HANDLER
ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  switch (data.type) {
    case "trade":
      addTrade(data.payload);
      break;

    case "portfolio":
      updateBots(data.payload);
      break;

    case "reasoning":
      addLogLine(data.payload);
      break;

    case "sentiment":
      updateSentiment(data.payload);
      break;

    case "symbols":
      updateCarouselSymbols(data.payload);
      break;
  }
};

// --------------------------------------------------
// CHART INITIALIZATION
// --------------------------------------------------

function initChart(symbol) {
  currentSymbol = symbol;
  document.getElementById("current-symbol").innerText = `Symbol: ${symbol}`;

  chartEl.innerHTML = ""; // clear old chart

  chart = LightweightCharts.createChart(chartEl, {
    layout: {
      background: { color: "#0d0f1a" },
      textColor: "#9bb4ff"
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.05)" },
      horzLines: { color: "rgba(255,255,255,0.05)" }
    },
    timeScale: { timeVisible: true, secondsVisible: true },
    crosshair: { vertLine: { color: "#9bb4ff" }, horzLine: { color: "#9bb4ff" } }
  });

  candleSeries = chart.addLineSeries({
    color: "#9bb4ff",
    lineWidth: 2
  });

  sentimentSeries = chart.addLineSeries({
    color: "#ff497c",
    lineWidth: 1,
    lineStyle: LightweightCharts.LineStyle.Dotted
  });

  // Pull historical data once
  loadHistory(symbol);
}

async function loadHistory(symbol) {
  try {
    const r = await fetch(`/api/history/${symbol}`);
    const j = await r.json();
    if (!j.ok) return;

    candleSeries.setData(j.data);
    sentimentSeries.setData(j.sentiment || []);
  } catch (e) {}
}

// --------------------------------------------------
// TRADES PANEL UPDATE
// --------------------------------------------------

function addTrade(t) {
  const div = document.createElement("div");
  div.className = "trade-row";

  const color = t.side === "BUY" ? "trade-buy" : "trade-sell";

  div.innerHTML = `
    <div class="${color}"><strong>${t.strategy.toUpperCase()}</strong> → ${t.side} ${t.symbol}</div>
    <div>Qty: ${t.qty.toFixed(4)} @ $${t.price.toFixed(2)}</div>
    <div style="opacity: 0.6;">${t.note}</div>
  `;

  tradesPanel.prepend(div);
}

// --------------------------------------------------
// BOT STATUS PANEL
// --------------------------------------------------

function updateBots(snapshot) {
  botsPanel.innerHTML = "";

  snapshot.bots.forEach((b) => {
    const pos = snapshot.positions[b.strategy] || [];
    const posValue = pos.reduce((a, p) => a + p.qty * p.avg_price, 0);
    const equity = b.cash + posValue;
    const progress = Math.min(100, (equity / b.target_cash) * 100);

    const card = document.createElement("div");
    card.className = "bot-card";

    card.innerHTML = `
      <div class="bot-title">${b.strategy.toUpperCase()}</div>
      <div>Cash: $${b.cash.toFixed(2)}</div>
      <div>Positions: $${posValue.toFixed(2)}</div>
      <div><strong>Total Equity: $${equity.toFixed(2)}</strong></div>

      <div class="progress-bar">
        <div class="progress-inner" style="width:${progress}%;"></div>
      </div>
    `;

    botsPanel.appendChild(card);
  });
}

// --------------------------------------------------
// LOG FEED
// --------------------------------------------------

function addLogLine({ ts, strategy, rationale }) {
  const div = document.createElement("div");
  div.className = "log-line";
  div.innerHTML = `[${new Date(ts).toLocaleTimeString()}] 
    <strong>${strategy}</strong>: ${rationale}`;
  logEl.prepend(div);
}

// --------------------------------------------------
// SENTIMENT UPDATES
// --------------------------------------------------

function updateSentiment({ symbol, price, sentiment }) {
  if (symbol !== currentSymbol) return;

  candleSeries.update({ time: Date.now() / 1000, value: price });
  sentimentSeries.update({ time: Date.now() / 1000, value: sentiment });
}

// --------------------------------------------------
// SYMBOL CAROUSEL (5 seconds)
// --------------------------------------------------

function updateCarouselSymbols(list) {
  carouselSymbols = list;
}

setInterval(() => {
  if (carouselSymbols.length === 0) return;

  currentSymbolIndex = (currentSymbolIndex + 1) % carouselSymbols.length;
  const sym = carouselSymbols[currentSymbolIndex];

  initChart(sym);
}, 5000);

