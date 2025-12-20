const $ = (id) => document.getElementById(id);

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  try { return JSON.parse(txt); }
  catch { throw new Error(`Non-JSON from ${url}: ${txt.slice(0, 120)}`); }
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

function renderTrades(items) {
  const tb = $("tradeStreamBody");
  if (!items || !items.length) {
    tb.innerHTML = `<tr class="muted"><td class="py-3" colspan="7">No trades yet.</td></tr>`;
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
    return `
      <button data-bot="${p.bot}" class="botCard chip rounded-2xl p-4 text-left hover:opacity-95">
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

  // Hook clicks (drawer)
  document.querySelectorAll(".botCard").forEach(el => {
    el.addEventListener("click", () => openBotDrawer(el.getAttribute("data-bot")));
  });
}

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

// Drawer
function showDrawer(open) {
  const d = $("botDrawer");
  if (!d) return;
  d.classList.toggle("hidden", !open);
}

async function openBotDrawer(bot) {
  showDrawer(true);
  $("drawerTitle").textContent = `Bot: ${bot}`;
  $("drawerBody").innerHTML = `<div class="muted">Loading…</div>`;

  try {
    const data = await getJSON(`/api/trades/bot/${encodeURIComponent(bot)}?limit=100`);
    const items = data.items || [];

    if (!items.length) {
      $("drawerBody").innerHTML = `<div class="muted">No trades yet for ${bot}.</div>`;
      return;
    }

    $("drawerBody").innerHTML = `
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="muted">
            <tr class="text-left">
              <th class="py-2 pr-3">Time</th>
              <th class="py-2 pr-3">Side</th>
              <th class="py-2 pr-3">Symbol</th>
              <th class="py-2 pr-3">Qty</th>
              <th class="py-2 pr-3">Price</th>
              <th class="py-2">Why</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(t => `
              <tr class="border-t border-white/5">
                <td class="py-2 pr-3 muted">${new Date(t.ts).toLocaleString()}</td>
                <td class="py-2 pr-3">${t.side}</td>
                <td class="py-2 pr-3">${t.symbol}</td>
                <td class="py-2 pr-3">${Number(t.qty||0).toFixed(3)}</td>
                <td class="py-2 pr-3">$${Number(t.price||0).toFixed(2)}</td>
                <td class="py-2 muted">${t.rationale || ""}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    $("drawerBody").innerHTML = `<div class="text-sm text-red-200">Error: ${e.message}</div>`;
  }
}

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
        pushEventLine(`♻ Carousel → ${msg.payload?.symbol} • Market: ${m?.open ? "OPEN" : "CLOSED"} (${m?.reason || ""})`);
      }

      if (msg.type === "bot_fight") {
        const sym = msg.payload?.symbol;
        const winner = msg.payload?.winner;
        const allowed = msg.payload?.tradesAllowed;
        const np = msg.payload?.newsProvider;
        pushEventLine(`⚔️ Fight: ${sym} • winner=${winner} • trades=${allowed ? "YES" : "NO"} • news=${np}`);
        await refreshWarRoom();
      }

      if (msg.type === "learning_evaluated") {
        pushEventLine(`🧠 Learning evaluated: ${msg.payload?.evaluated || 0} samples`);
      }

      if (msg.type === "runner_error") {
        pushEventLine(`⚠ Runner error: ${msg.payload?.symbol || "—"} • ${msg.payload?.error || "unknown"}`);
      }
    } catch {}
  };

  return ws;
}

(function init() {
  const closeBtn = $("drawerClose");
  if (closeBtn) closeBtn.addEventListener("click", () => showDrawer(false));

  refreshWarRoom().catch(() => {});
  connectWS();
  setInterval(() => refreshWarRoom().catch(() => {}), 15000);
})();
