const $ = (id) => document.getElementById(id);

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  try { return JSON.parse(txt); }
  catch { throw new Error(`Non-JSON from ${url}`); }
}

function setWsStatus(text) {
  $("wsStatus").textContent = text;
}

function pushEventLine(text) {
  const box = $("eventStream");
  if (box.querySelector(".muted") && box.children.length === 1) box.innerHTML = "";

  const div = document.createElement("div");
  div.className = "chip rounded-xl px-3 py-2 text-xs";
  div.textContent = text;
  box.prepend(div);

  while (box.children.length > 80) box.removeChild(box.lastChild);
}

/* -----------------------------
   Trades Stream (main table)
------------------------------ */
function renderTrades(items) {
  const tb = $("tradeStreamBody");
  if (!items || !items.length) {
    tb.innerHTML = `<tr class="muted"><td class="py-3" colspan="7">—</td></tr>`;
    return;
  }
  tb.innerHTML = items.slice(0, 25).map(t => `
    <tr class="border-t border-white/5">
      <td class="py-2 pr-3 muted">${new Date(t.ts).toLocaleString()}</td>
      <td class="py-2 pr-3">${t.bot}</td>
      <td class="py-2 pr-3">${t.side}</td>
      <td class="py-2 pr-3">${t.symbol}</td>
      <td class="py-2 pr-3">${Number(t.qty || 0).toFixed(3)}</td>
      <td class="py-2 pr-3">$${Number(t.price || 0).toFixed(2)}</td>
      <td class="py-2 muted">${t.rationale || ""}</td>
    </tr>
  `).join("");
}

/* -----------------------------
   Bankrolls (clickable cards)
------------------------------ */
function renderBankroll(items) {
  const box = $("bankrollBox");
  if (!items || !items.length) {
    box.innerHTML = `<div class="muted">—</div>`;
    return;
  }

  box.innerHTML = items.map(p => {
    const cash = Number(p.cash);
    const goal = Number(p.goal);
    const pct = Math.max(0, Math.min(100, (cash / goal) * 100));

    // CLICKABLE button + data attributes
    return `
      <button
        class="chip w-full text-left rounded-2xl p-4 hover:opacity-95 focus:outline-none"
        data-bot="${p.bot}"
        data-label="${p.bot}"
      >
        <div class="flex items-center justify-between">
          <div class="font-semibold">${p.bot}</div>
          <div class="text-xs muted">$${cash.toFixed(2)}</div>
        </div>
        <div class="mt-3 h-2 rounded-full bg-white/10 overflow-hidden">
          <div style="width:${pct}%" class="h-2 bg-gradient-to-r from-indigo-500 to-fuchsia-500"></div>
        </div>
        <div class="mt-2 text-xs muted">Progress to $${goal.toFixed(0)} • ${pct.toFixed(1)}%</div>
      </button>
    `;
  }).join("");

  // Wire clicks after render
  box.querySelectorAll("button[data-bot]").forEach(btn => {
    btn.addEventListener("click", () => {
      const bot = btn.getAttribute("data-bot");
      const label = btn.getAttribute("data-label") || bot;
      openBotDrawer(bot, label).catch(() => {});
    });
  });
}

/* -----------------------------
   Runner Panel
------------------------------ */
async function refreshWarRoom() {
  const p = await getJSON("/api/portfolios");
  renderBankroll(p.items || []);

  const t = await getJSON("/api/trades/recent?limit=25");
  renderTrades(t.items || []);

  const r = await getJSON("/api/runner/status");
  $("runnerInfo").innerHTML = `
    <div><b>Enabled:</b> ${r.enabled ? "YES" : "NO"}</div>
    <div><b>Interval:</b> ${r.intervalSec}s</div>
    <div><b>Market:</b> ${r.market.open ? "OPEN" : "CLOSED"} (${r.market.reason})</div>
    <div><b>News-only when closed:</b> ${r.newsOnlyWhenClosed ? "YES" : "NO"}</div>
    <div><b>Universe:</b> ${r.universe.mode}${r.universe.mode==="custom" ? ` (${(r.universe.custom||[]).length})` : ""}</div>
    <div><b>Last symbol:</b> ${r.state.lastSymbol || "—"}</div>
    <div><b>Next symbol:</b> ${r.nextSymbol || "—"}</div>
  `;
}

/* -----------------------------
   Bot Drawer (Phase 3+4)
------------------------------ */
let drawerOpen = false;
let activeDrawerBot = null;
let activeDrawerLabel = null;

function showDrawer() {
  drawerOpen = true;
  $("drawerOverlay").classList.remove("hidden");
  $("botDrawer").classList.remove("hidden");
  document.body.classList.add("overflow-hidden");
}
function hideDrawer() {
  drawerOpen = false;
  activeDrawerBot = null;
  activeDrawerLabel = null;
  $("drawerOverlay").classList.add("hidden");
  $("botDrawer").classList.add("hidden");
  document.body.classList.remove("overflow-hidden");
}

function verdictChip(v) {
  const vv = String(v || "PENDING").toUpperCase();
  if (vv === "WIN") return `<span class="chip px-2 py-1 rounded-lg text-xs">WIN</span>`;
  if (vv === "LOSS") return `<span class="chip px-2 py-1 rounded-lg text-xs">LOSS</span>`;
  return `<span class="chip px-2 py-1 rounded-lg text-xs">PENDING</span>`;
}

/**
 * Bot-level learning stats endpoint (Phase 4 server.js)
 * GET /api/learning/verdicts?bot=...
 * -> provides stats for win-rate KPI (not trade-level mapping).
 */
async function loadBotVerdictStats(bot) {
  try {
    const out = await getJSON(`/api/learning/verdicts?bot=${encodeURIComponent(bot)}`);
    return out && out.stats ? out.stats : null;
  } catch {
    return null;
  }
}

async function loadBotPortfolio(bot) {
  try {
    const p = await getJSON("/api/portfolios");
    const items = p.items || [];
    return items.find(x => x.bot === bot) || null;
  } catch {
    return null;
  }
}

function computeWinRateFromTrades(items) {
  // Prefer trade-level verdicts for KPI if present
  let win = 0, loss = 0, pending = 0;
  for (const t of (items || [])) {
    const v = String(t.learningVerdict || "PENDING").toUpperCase();
    if (v === "WIN") win++;
    else if (v === "LOSS") loss++;
    else pending++;
  }
  const denom = win + loss;
  const wr = denom > 0 ? Math.round((win / denom) * 100) : null;
  return { win, loss, pending, winRate: wr };
}

function renderDrawerHeader({ bot, label, portfolio, tradesCount, tradeKpi, statsFallback }) {
  $("drawerTitle").textContent = label || bot;
  $("drawerSub").textContent = bot ? `Strategy key: ${bot}` : "—";

  if (portfolio) {
    $("drawerCash").textContent = `$${Number(portfolio.cash || 0).toFixed(2)}`;
  } else {
    $("drawerCash").textContent = "—";
  }

  $("drawerTradesCount").textContent = String(tradesCount ?? "—");

  // Win rate priority:
  // 1) trade-level verdict KPI (best UX)
  // 2) server stats fallback
  let wr = (tradeKpi && tradeKpi.winRate != null) ? tradeKpi.winRate : null;

  if (wr == null && statsFallback && (statsFallback.win + statsFallback.loss) > 0) {
    wr = Math.round((statsFallback.win / (statsFallback.win + statsFallback.loss)) * 100);
  }

  $("drawerWinRate").textContent = (wr == null) ? "—" : `${wr}%`;
}

function renderDrawerTrades(items) {
  const tb = $("drawerTradesBody");
  if (!items || !items.length) {
    tb.innerHTML = `<tr class="muted"><td class="py-3" colspan="7">No trades yet.</td></tr>`;
    return;
  }

  tb.innerHTML = items.map(t => {
    const v = t.learningVerdict || "PENDING";
    const why = (t.rationale || "").slice(0, 170);
    return `
      <tr class="border-t border-white/5">
        <td class="py-2 pr-3 muted">${new Date(t.ts).toLocaleString()}</td>
        <td class="py-2 pr-3">${t.side}</td>
        <td class="py-2 pr-3">${t.symbol}</td>
        <td class="py-2 pr-3">${Number(t.qty || 0).toFixed(3)}</td>
        <td class="py-2 pr-3">$${Number(t.price || 0).toFixed(2)}</td>
        <td class="py-2 pr-3 muted">${verdictChip(v)}</td>
        <td class="py-2 muted">${why}</td>
      </tr>
    `;
  }).join("");
}

async function openBotDrawer(bot, label) {
  activeDrawerBot = bot;
  activeDrawerLabel = label;

  // Open immediately (perceived performance)
  showDrawer();

  $("drawerTitle").textContent = label || bot;
  $("drawerSub").textContent = "Loading bot intelligence…";
  $("drawerCash").textContent = "—";
  $("drawerWinRate").textContent = "—";
  $("drawerTradesCount").textContent = "—";
  $("drawerLastUpdated").textContent = "—";
  $("drawerTradesBody").innerHTML = `<tr class="muted"><td class="py-3" colspan="7">Loading…</td></tr>`;

  // Fetch portfolio + trades + stats
  const [portfolio, tradesOut, statsFallback] = await Promise.all([
    loadBotPortfolio(bot),
    getJSON(`/api/trades/bot/${encodeURIComponent(bot)}?limit=300`).catch(() => ({ items: [] })),
    loadBotVerdictStats(bot)
  ]);

  const items = (tradesOut && tradesOut.items) ? tradesOut.items : [];
  const tradeKpi = computeWinRateFromTrades(items);

  renderDrawerHeader({
    bot,
    label,
    portfolio,
    tradesCount: items.length,
    tradeKpi,
    statsFallback
  });

  // Drawer subtitle: make it explicit that verdicts are real and time-delayed
  $("drawerSub").textContent =
    "Full trade history + learning verdicts (evaluated after horizon)";

  $("drawerLastUpdated").textContent = `Updated: ${new Date().toLocaleTimeString()}`;

  // Render trade table
  renderDrawerTrades(items);
}

/* -----------------------------
   WebSocket
------------------------------ */
function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setWsStatus("WS: live ✅");
  ws.onclose = () => setWsStatus("WS: closed (refresh) ⚠️");
  ws.onerror = () => setWsStatus("WS: error ⚠️");

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      $("lastEvent").textContent = `${msg.type} • ${new Date(msg.ts).toLocaleTimeString()}`;

      if (msg.type === "carousel_tick") {
        $("carouselSymbol").textContent = msg.payload?.symbol || "—";
        const m = msg.payload?.market;
        pushEventLine(`♻ Carousel: ${msg.payload?.symbol} • Market: ${m?.open ? "OPEN" : "CLOSED"} (${m?.reason || ""})`);
      }

      if (msg.type === "bot_fight") {
        const sym = msg.payload?.symbol;
        const winner = msg.payload?.winner;
        const allowed = msg.payload?.tradesAllowed;
        pushEventLine(`⚔️ Fight: ${sym} • winner=${winner} • trades=${allowed ? "YES" : "NO"}`);

        // Refresh core panels
        await refreshWarRoom();

        // If drawer is open, refresh its content (keeps drawer “alive”)
        if (drawerOpen && activeDrawerBot) {
          openBotDrawer(activeDrawerBot, activeDrawerLabel).catch(() => {});
        }
      }

      if (msg.type === "learning_evaluated") {
        pushEventLine(`🧠 Learning evaluated: ${msg.payload?.evaluated || 0} samples`);

        // Refresh drawer so verdict chips can flip from PENDING -> WIN/LOSS
        if (drawerOpen && activeDrawerBot) {
          openBotDrawer(activeDrawerBot, activeDrawerLabel).catch(() => {});
        }
      }
    } catch {}
  };

  return ws;
}

/* -----------------------------
   Drawer close handlers
------------------------------ */
function wireDrawerControls() {
  const overlay = $("drawerOverlay");
  const closeBtn = $("drawerClose");

  overlay.addEventListener("click", () => hideDrawer());
  closeBtn.addEventListener("click", () => hideDrawer());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawerOpen) hideDrawer();
  });
}

/* -----------------------------
   Init
------------------------------ */
(async function init() {
  wireDrawerControls();
  await refreshWarRoom();
  connectWS();

  // REST fallback refresh cadence (WS is primary)
  setInterval(() => refreshWarRoom().catch(() => {}), 15000);
})();
