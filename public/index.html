<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AI Trading Arena</title>

  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>

  <style>
    body{
      background:
        radial-gradient(1200px 700px at 20% 10%, rgba(99,102,241,.22), transparent 60%),
        radial-gradient(900px 600px at 80% 60%, rgba(20,184,166,.18), transparent 55%),
        #060912;
      color:#e5e7eb;
    }
    .glass{
      background: rgba(17,24,39,.58);
      border: 1px solid rgba(255,255,255,.08);
      box-shadow: 0 20px 80px rgba(0,0,0,.45);
      backdrop-filter: blur(14px);
    }
    .chip{
      border:1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.06);
    }
    .muted{ color: rgba(229,231,235,.68); }

    .modal-bg{
      background: rgba(0,0,0,.58);
      backdrop-filter: blur(6px);
    }
    .modal{
      background: rgba(17,24,39,.72);
      border: 1px solid rgba(255,255,255,.10);
      box-shadow: 0 24px 90px rgba(0,0,0,.60);
      backdrop-filter: blur(18px);
    }

    .pill-good{ background: rgba(16,185,129,.18); border: 1px solid rgba(16,185,129,.25); }
    .pill-bad{ background: rgba(239,68,68,.18); border: 1px solid rgba(239,68,68,.25); }
    .pill-mix{ background: rgba(245,158,11,.18); border: 1px solid rgba(245,158,11,.25); }
  </style>
</head>

<body class="min-h-screen">
  <div class="max-w-6xl mx-auto px-6 py-10">

    <!-- Header -->
    <div class="flex items-start justify-between gap-6">
      <div>
        <h1 class="text-4xl font-bold tracking-tight">AI Trading Arena</h1>
        <p class="mt-2 muted max-w-2xl">
          Autonomous trading intelligence. Four bots. Continuous learning.
          <span class="block mt-1">Live-by-default: the engine runs continuously.</span>
        </p>
      </div>
      <div class="flex items-center gap-3">
        <button id="howItWorksBtn" class="chip px-4 py-2 rounded-xl hover:opacity-90">❓ How it works</button>
        <a href="/war-room.html" class="chip px-4 py-2 rounded-xl hover:opacity-90">⚔️ War Room</a>
        <span id="wsStatus" class="chip px-3 py-2 rounded-xl text-xs muted">WS: connecting…</span>
      </div>
    </div>

    <!-- LIVE STATUS BAR -->
    <div class="glass mt-8 rounded-2xl p-5">
      <div class="grid md:grid-cols-4 gap-4">
        <div>
          <div class="text-xs muted">Current Symbol</div>
          <div id="liveSymbol" class="text-2xl font-bold mt-1">—</div>
        </div>
        <div>
          <div class="text-xs muted">Market State</div>
          <div id="marketState" class="text-lg font-semibold mt-1">—</div>
        </div>
        <div>
          <div class="text-xs muted">Last Event</div>
          <div id="lastEvent" class="text-sm mt-2 muted">—</div>
        </div>
        <div>
          <div class="text-xs muted">Mode</div>
          <div id="modeBox" class="text-lg font-semibold mt-1">—</div>
        </div>
      </div>
    </div>

    <!-- MAIN GRID -->
    <div class="grid lg:grid-cols-12 gap-6 mt-8">

      <!-- LEFT: BOT DECISIONS -->
      <div class="lg:col-span-7 glass rounded-2xl p-6">
        <div class="flex items-center justify-between">
          <h2 class="text-xl font-semibold">Latest Bot Decisions</h2>
          <span class="chip px-3 py-1 rounded-lg text-xs muted">Auto-updated</span>
        </div>

        <div class="grid sm:grid-cols-3 gap-4 mt-5">
          <div class="chip rounded-2xl p-4">
            <div class="text-xs muted">Price</div>
            <div id="priceBox" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="chip rounded-2xl p-4">
            <div class="text-xs muted">Change %</div>
            <div id="chgBox" class="text-2xl font-bold mt-1">—</div>
          </div>
          <div class="chip rounded-2xl p-4">
            <div class="text-xs muted">Avg News Sentiment</div>
            <div id="sentBox" class="text-2xl font-bold mt-1">—</div>
          </div>
        </div>

        <div class="mt-5 chip rounded-2xl p-4">
          <div class="text-xs muted">Winning Strategy</div>
          <div id="winnerBox" class="text-lg font-semibold mt-1">—</div>
          <div id="marketDetail" class="text-xs muted mt-2">—</div>
        </div>

        <div class="mt-6">
          <h3 class="font-semibold">Bot Signals</h3>
          <div id="botsList" class="mt-3 grid sm:grid-cols-2 gap-3"></div>
        </div>
      </div>

      <!-- RIGHT: NEWS INTELLIGENCE -->
      <div class="lg:col-span-5 glass rounded-2xl p-6">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-xl font-semibold">News Intelligence</h2>
            <p class="text-sm muted mt-1">Regular news → which US-traded stocks may be impacted</p>
          </div>
          <span id="newsProviderBadge" class="chip px-3 py-1 rounded-lg text-xs muted">Provider: —</span>
        </div>

        <div id="newsBox" class="mt-4 space-y-3">
          <div class="muted">Loading general news…</div>
        </div>
      </div>

      <!-- FULL WIDTH: LEARNING IMPACT -->
      <div class="lg:col-span-12 glass rounded-2xl p-6">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="text-xl font-semibold">Learning Impact</h2>
            <p class="text-sm muted mt-1">Evaluated decisions (WIN/LOSS) shift bot confidence over time.</p>
          </div>
          <span class="chip px-3 py-1 rounded-lg text-xs muted" id="learningMeta">Loading…</span>
        </div>

        <div class="mt-4 chip rounded-2xl p-4">
          <canvas id="learningChart" height="90"></canvas>
        </div>

        <div class="mt-3 text-xs muted">
          Accuracy is calculated from evaluated learning samples (PENDING excluded). Forward-time evaluation, not backfilled.
        </div>
      </div>
    </div>

  </div>

  <!-- How it works modal (kept simple here) -->
  <div id="howModalOverlay" class="hidden fixed inset-0 modal-bg"></div>
  <div id="howModal" class="hidden fixed inset-0 flex items-center justify-center p-5">
    <div class="modal w-full max-w-4xl rounded-3xl overflow-hidden">
      <div class="flex items-start justify-between gap-4 p-5 border-b border-white/10">
        <div>
          <div class="text-xs muted">Orientation</div>
          <h3 class="text-xl font-semibold mt-1">How this system works</h3>
          <p class="text-sm muted mt-1">Observe → Decide → Act (or Simulate) → Learn → Repeat</p>
        </div>
        <button id="howModalClose" class="chip px-3 py-2 rounded-xl hover:opacity-90">✕</button>
      </div>
      <div class="p-5">
        <div class="chip rounded-2xl p-4">
          <div class="text-sm">
            Bots observe prices + news, make decisions, and learning evaluates outcomes after time passes to refine confidence.
          </div>
          <div class="text-xs muted mt-2">
            This is forward-time learning: decisions are scored later (WIN/LOSS/PENDING), then reused.
          </div>
        </div>
      </div>
      <div class="p-5 border-t border-white/10 flex items-center justify-between">
        <div class="text-xs muted">Tip: press <b>ESC</b> to close</div>
        <button id="howModalClose2" class="chip px-4 py-2 rounded-xl hover:opacity-90">Close</button>
      </div>
    </div>
  </div>

  <!-- Article → Impact modal -->
  <div id="articleModal" class="hidden fixed inset-0 modal-bg">
    <div class="modal max-w-3xl mx-auto mt-14 rounded-3xl overflow-hidden">
      <div class="flex items-start justify-between gap-4 p-5 border-b border-white/10">
        <div>
          <div class="text-xs muted">Article impact research</div>
          <h3 class="text-xl font-semibold mt-1" id="articleTitle">—</h3>
          <div class="text-xs muted mt-2" id="articleMeta">—</div>
        </div>
        <button id="closeArticle" class="chip px-3 py-2 rounded-xl hover:opacity-90">✕</button>
      </div>

      <div class="p-5">
        <div class="text-sm muted">Likely impacted US-traded companies:</div>
        <div id="impactList" class="mt-3 space-y-2">
          <div class="muted">Loading…</div>
        </div>
        <div class="text-xs muted mt-4" id="impactProvider">—</div>
      </div>

      <div class="p-5 border-t border-white/10 flex items-center justify-end">
        <button id="closeArticle2" class="chip px-4 py-2 rounded-xl hover:opacity-90">Close</button>
      </div>
    </div>
  </div>

<script>
const $ = (id) => document.getElementById(id);

let currentSymbol = null;
let ws = null;

// -----------------------------
// Modal controls
// -----------------------------
function openHowModal(){
  $("howModalOverlay").classList.remove("hidden");
  $("howModal").classList.remove("hidden");
  document.body.classList.add("overflow-hidden");
}
function closeHowModal(){
  $("howModalOverlay").classList.add("hidden");
  $("howModal").classList.add("hidden");
  document.body.classList.remove("overflow-hidden");
}
$("howItWorksBtn").addEventListener("click", openHowModal);
$("howModalOverlay").addEventListener("click", closeHowModal);
$("howModalClose").addEventListener("click", closeHowModal);
$("howModalClose2").addEventListener("click", closeHowModal);
document.addEventListener("keydown", (e) => { if(e.key === "Escape") { closeHowModal(); closeArticleModal(); } });

function openArticleModal(){
  $("articleModal").classList.remove("hidden");
  document.body.classList.add("overflow-hidden");
}
function closeArticleModal(){
  $("articleModal").classList.add("hidden");
  document.body.classList.remove("overflow-hidden");
}
$("closeArticle").addEventListener("click", closeArticleModal);
$("closeArticle2").addEventListener("click", closeArticleModal);
$("articleModal").addEventListener("click", (e) => { if(e.target === $("articleModal")) closeArticleModal(); });

// -----------------------------
// Helpers
// -----------------------------
async function getJSON(url, opts){
  const r = await fetch(url, opts);
  const t = await r.text();
  return JSON.parse(t);
}
function setWsStatus(t){ $("wsStatus").textContent = t; }

function renderBots(bots){
  const box = $("botsList");
  box.innerHTML = "";
  for(const b of (bots || [])){
    const d = document.createElement("div");
    d.className = "chip rounded-2xl p-4";
    d.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="font-semibold">${b.label || b.strategy}</div>
        <div class="text-xs muted">${b.horizon || ""}</div>
      </div>
      <div class="mt-2 text-sm">
        <span class="font-semibold">${b.signal}</span>
        <span class="muted">• confidence ${b.confidence}</span>
      </div>
      <div class="mt-2 text-xs muted">${b.rationale || ""}</div>
    `;
    box.appendChild(d);
  }
}

// -----------------------------
// News Intelligence (general news + article→stocks impact)
// -----------------------------
function renderNews(pack){
  const box = $("newsBox");
  $("newsProviderBadge").textContent = `Provider: ${pack?.provider || "—"}`;

  const items = pack?.items || [];
  if(!items.length){
    box.innerHTML = `<div class="muted">No headlines available</div>`;
    return;
  }

  box.innerHTML = items.map((n, idx) => `
    <button data-idx="${idx}" class="w-full text-left chip rounded-2xl p-4 hover:opacity-90">
      <div class="text-sm font-semibold">${n.title}</div>
      <div class="text-xs muted mt-1">${n.source} • ${n.publishedAt ? new Date(n.publishedAt).toLocaleString() : ""}</div>
      <div class="text-xs muted mt-2">${n.summary || ""}</div>
      <div class="text-xs muted mt-2">Click to see impacted stocks →</div>
    </button>
  `).join("");

  box.querySelectorAll("button[data-idx]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const i = Number(btn.getAttribute("data-idx"));
      const article = items[i];

      $("articleTitle").textContent = article.title || "Article";
      $("articleMeta").textContent = `${article.source || ""} • ${article.publishedAt ? new Date(article.publishedAt).toLocaleString() : ""}`;
      $("impactList").innerHTML = `<div class="muted">Analyzing…</div>`;
      $("impactProvider").textContent = "—";
      openArticleModal();

      try {
        const out = await getJSON("/api/news/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: article.title || "", summary: article.summary || "" })
        });

        const itemsOut = out.items || [];
        if(!itemsOut.length){
          $("impactList").innerHTML = `<div class="muted">No confident impacted tickers detected for this headline.</div>`;
          $("impactProvider").textContent = `Provider: ${out.provider || "—"}`;
          return;
        }

        $("impactList").innerHTML = itemsOut.map(x => {
          const pill = x.direction === "benefit" ? "pill-good" : x.direction === "risk" ? "pill-bad" : "pill-mix";
          return `
            <div class="chip rounded-2xl p-4">
              <div class="flex items-center justify-between gap-3">
                <div class="font-semibold">${x.ticker} <span class="muted font-normal">• ${x.company || ""}</span></div>
                <div class="text-xs px-3 py-1 rounded-full ${pill}">
                  ${x.direction.toUpperCase()} • ${x.horizon} • ${x.confidence}%
                </div>
              </div>
              <div class="text-xs muted mt-2">${x.why || ""}</div>
            </div>
          `;
        }).join("");

        $("impactProvider").textContent = `Provider: ${out.provider || "—"} • Note: this is causal inference from the headline/summary.`;
      } catch(e){
        $("impactList").innerHTML = `<div class="muted">Impact analysis failed. Check server logs.</div>`;
      }
    });
  });
}

async function loadGeneralNews(){
  const pack = await getJSON("/api/news/general?limit=8");
  renderNews(pack);
}

// -----------------------------
// Learning impact chart
// -----------------------------
let learningChart = null;

function destroyChart(ch){ try{ if(ch) ch.destroy(); }catch{} return null; }

function buildSeriesToDatasets(byStrategy){
  const datasets = [];
  const allDays = new Set();
  Object.keys(byStrategy || {}).forEach(k => (byStrategy[k] || []).forEach(pt => { if(pt.day) allDays.add(pt.day); }));
  const labels = Array.from(allDays).sort();

  for(const strategyKey of Object.keys(byStrategy || {})){
    const map = new Map((byStrategy[strategyKey] || []).map(pt => [pt.day, pt.accuracy]));
    const data = labels.map(day => {
      const v = map.get(day);
      return (v === null || v === undefined) ? null : Number(v.toFixed(2));
    });
    datasets.push({ label: String(strategyKey), data, spanGaps: true, tension: 0.25, borderWidth: 2, pointRadius: 2 });
  }
  return { labels, datasets };
}

async function refreshLearningImpact(){
  const out = await getJSON("/api/learning/impact?days=14");
  const byStrategy = out.byStrategy || {};
  const { labels, datasets } = buildSeriesToDatasets(byStrategy);

  const evaluatedTotal = Object.values(byStrategy).flat().reduce((acc, pt) => acc + Number(pt.evaluated || 0), 0);
  $("learningMeta").textContent = `Last ${out.days || 14} days • Evaluated samples: ${evaluatedTotal}`;

  learningChart = destroyChart(learningChart);
  learningChart = new Chart($("learningChart").getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "rgba(229,231,235,0.78)" } },
        tooltip: { intersect: false, mode: "index" }
      },
      scales: {
        x: { ticks: { color: "rgba(229,231,235,0.55)" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: {
          suggestedMin: 0,
          suggestedMax: 100,
          ticks: { color: "rgba(229,231,235,0.55)", callback: (v) => `${v}%` },
          grid: { color: "rgba(255,255,255,0.06)" }
        }
      }
    }
  });
}

// -----------------------------
// WebSocket live loop + instant hydration
// -----------------------------
async function hydrateFromRunnerStatus(){
  try {
    const r = await getJSON("/api/runner/status");
    const sym = r.state?.lastSymbol || "AAPL";
    currentSymbol = sym;
    $("liveSymbol").textContent = sym;
    $("marketState").textContent = r.market.open ? "OPEN" : r.market.reason;
    $("modeBox").textContent = r.market.open ? "Live trading" : "News-only learning";
  } catch {}
}

function connectWS(){
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setWsStatus("WS: live ✅");
  ws.onclose = () => setWsStatus("WS: closed ⚠️");
  ws.onerror = () => setWsStatus("WS: error ⚠️");

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    $("lastEvent").textContent = `${msg.type} • ${new Date(msg.ts).toLocaleTimeString()}`;

    if(msg.type === "carousel_tick"){
      currentSymbol = msg.payload.symbol;
      $("liveSymbol").textContent = currentSymbol;
      $("marketState").textContent = msg.payload.market.open ? "OPEN" : msg.payload.market.reason;
      $("modeBox").textContent = msg.payload.market.open ? "Live trading" : "News-only learning";
    }

    if(msg.type === "bot_fight"){
      const f = msg.payload.features || {};
      $("priceBox").textContent = f.price ? `$${Number(f.price).toFixed(2)}` : "—";
      $("chgBox").textContent = f.changePercent !== undefined ? `${Number(f.changePercent).toFixed(2)}%` : "—";
      $("sentBox").textContent = f.avgSent !== undefined ? Number(f.avgSent).toFixed(2) : "—";
      $("winnerBox").textContent = msg.payload.winner || "—";
      $("marketDetail").textContent =
        `Market: ${msg.payload.market.open ? "OPEN" : "CLOSED"} • Trades: ${msg.payload.tradesAllowed ? "YES" : "NO"}`;

      renderBots(msg.payload.bots || []);
    }

    if(msg.type === "learning_evaluated"){
      refreshLearningImpact().catch(()=>{});
    }
  };
}

// Boot
(async function init(){
  await hydrateFromRunnerStatus();
  await loadGeneralNews();
  await refreshLearningImpact().catch(()=>{});
  connectWS();

  // keep news fresh every 90 seconds
  setInterval(() => loadGeneralNews().catch(()=>{}), 90000);
  setInterval(() => refreshLearningImpact().catch(()=>{}), 60000);
})();
</script>

</body>
</html>
