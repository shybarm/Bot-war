const $ = (id) => document.getElementById(id);

function setWsStatus(t) { $("wsStatus").textContent = t; }

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString(); } catch { return ""; }
}

function pushEventLine(line, ts) {
  const box = $("eventStream");
  if (!box) return;

  // remove placeholder
  if (box.querySelector(".placeholder")) box.innerHTML = "";

  const row = document.createElement("div");
  row.className = "chip rounded-xl p-3";
  row.innerHTML = `
    <div class="text-xs muted">${fmtTime(ts)} • ${line}</div>
  `;
  box.appendChild(row);

  // keep scroll pinned to bottom
  box.scrollTop = box.scrollHeight;
}

function renderBankroll(items) {
  const box = $("bankrollGrid");
  if (!box) return;
  box.innerHTML = (items || []).map((p) => {
    const cash = Number(p.cash || 0);
    const goal = Number(p.goal || 150000);
    const pct = goal > 0 ? (cash / goal) * 100 : 0;
    return `
      <div class="chip rounded-2xl p-4">
        <div class="flex items-center justify-between">
          <div class="font-semibold">${p.bot}</div>
          <div class="text-xs muted">${cash.toFixed(0)} / ${goal.toFixed(0)}</div>
        </div>
        <div class="mt-2 text-xs muted">Progress</div>
        <div class="mt-2 h-2 w-full rounded-full bg-white/10 overflow-hidden">
          <div class="h-2 rounded-full bg-white/30" style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%"></div>
        </div>
        <div class="mt-2 text-xs muted">${pct.toFixed(1)}%</div>
      </div>
    `;
  }).join("");
}

function renderTrades(items) {
  const tb = $("tradeStreamBody");
  if (!tb) return;
  if (!items || !items.length) {
    tb.innerHTML = `<tr class="muted"><td class="py-3" colspan="7">—</td></tr>`;
    return;
  }
  tb.innerHTML = items.map((t) => `
    <tr class="border-t border-white/10">
      <td class="py-2 pr-3 text-xs muted">${fmtTime(t.ts)}</td>
      <td class="py-2 pr-3">${t.bot}</td>
      <td class="py-2 pr-3">${t.side}</td>
      <td class="py-2 pr-3">${t.symbol}</td>
      <td class="py-2 pr-3">${Number(t.qty || 0).toFixed(0)}</td>
      <td class="py-2 pr-3">$${Number(t.price || 0).toFixed(2)}</td>
      <td class="py-2 text-xs muted">${t.rationale || ""}</td>
    </tr>
  `).join("");
}

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  return JSON.parse(txt);
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

function formatEvent(msg) {
  if (msg.type === "carousel_tick") {
    const m = msg.payload?.market;
    return `♻ Carousel: ${msg.payload?.symbol} • Market: ${m?.open ? "OPEN" : "CLOSED"} (${m?.reason || ""})`;
  }
  if (msg.type === "bot_fight") {
    const sym = msg.payload?.symbol;
    const winner = msg.payload?.winner;
    const allowed = msg.payload?.tradesAllowed;
    return `⚔️ Fight: ${sym} • winner=${winner} • trades=${allowed ? "YES" : "NO"}`;
  }
  if (msg.type === "learning_evaluated") {
    return `🧠 Learning evaluated: ${msg.payload?.evaluated || 0} samples`;
  }
  return `${msg.type}`;
}

// Key fix: on refresh, replay DB events so stream continues (no “starting over”)
async function hydrateEventsFromDb() {
  const box = $("eventStream");
  box.innerHTML = `<div class="muted placeholder">Loading events…</div>`;

  // local cursor so subsequent refreshes continue “where you left off”
  const lastSeen = Number(localStorage.getItem("warroom_last_event_id") || 0);

  const r = await getJSON(`/api/events/recent?limit=160&afterId=${lastSeen}`);
  const items = r.items || [];

  if (!items.length) {
    box.innerHTML = `<div class="muted placeholder">Waiting for events…</div>`;
    return;
  }

  box.innerHTML = "";
  for (const e of items) {
    pushEventLine(formatEvent(e), e.ts);
    localStorage.setItem("warroom_last_event_id", String(e.id));
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
      }

      // persist cursor if server provides id
      if (msg.id) localStorage.setItem("warroom_last_event_id", String(msg.id));

      pushEventLine(formatEvent(msg), msg.ts);

      if (msg.type === "bot_fight") await refreshWarRoom();
    } catch {}
  };

  return ws;
}

(async function init() {
  await refreshWarRoom();
  await hydrateEventsFromDb();
  connectWS();
  setInterval(() => refreshWarRoom().catch(() => {}), 15000);
})();
