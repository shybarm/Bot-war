const $ = (id) => document.getElementById(id);

function setWsStatus(t) {
  const el = $("wsStatus");
  if (el) el.textContent = t;
}

function fmtTime(ts) {
  try { return new Date(ts).toLocaleTimeString(); } catch { return ""; }
}

function pushEventLine(line, ts) {
  const box = $("eventStream");
  if (!box) return;

  if (box.querySelector(".placeholder")) box.innerHTML = "";

  const row = document.createElement("div");
  row.className = "text-xs text-slate-200/80";
  row.textContent = `${fmtTime(ts)}  ${line}`;

  box.prepend(row);

  // cap
  const nodes = box.querySelectorAll("div");
  if (nodes.length > 220) nodes[nodes.length - 1].remove();
}

function formatEvent(msg) {
  const type = msg.type || "event";
  const p = msg.payload || {};
  if (type === "carousel_tick") return `Carousel → ${p.symbol || "—"}`;
  if (type === "runner_state") return `Runner state updated (idx=${p.state?.idx ?? "—"})`;
  if (type === "server_boot") return `Server booted`;
  return `${type}`;
}

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return {}; }
}

function renderBankroll(items) {
  const box = $("bankrollGrid");
  if (!box) return;

  if (!items || !items.length) {
    box.innerHTML = `<div class="chip rounded-2xl p-4 muted text-sm">No portfolios yet.</div>`;
    return;
  }

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
        <div class="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
          <div class="h-2 bg-white/30" style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%"></div>
        </div>
        <div class="mt-2 text-xs muted">${pct.toFixed(1)}% to goal</div>
      </div>
    `;
  }).join("");
}

function renderTrades(items) {
  const body = $("tradeBody");
  if (!body) return;

  if (!items || !items.length) {
    body.innerHTML = `<tr><td class="muted text-sm py-3" colspan="7">No trades yet.</td></tr>`;
    return;
  }

  body.innerHTML = items.map((t) => `
    <tr class="border-t border-white/5">
      <td class="py-2 text-xs muted">${fmtTime(t.ts)}</td>
      <td class="py-2 text-xs">${t.bot || "—"}</td>
      <td class="py-2 text-xs">${t.side || "—"}</td>
      <td class="py-2 text-xs">${t.symbol || "—"}</td>
      <td class="py-2 text-xs muted">${Number(t.qty || 0)}</td>
      <td class="py-2 text-xs muted">${Number(t.price || 0).toFixed(2)}</td>
      <td class="py-2 text-xs muted">${(t.rationale || "").slice(0, 90)}</td>
    </tr>
  `).join("");
}

async function refreshWarRoom() {
  // portfolios
  try {
    const p = await getJSON("/api/portfolios");
    renderBankroll(p.items || []);
  } catch {}

  // trades
  try {
    const t = await getJSON("/api/trades/recent?limit=25");
    renderTrades(t.items || []);
  } catch {}

  // runner status (IMPORTANT: do not assume optional fields exist)
  try {
    const r = await getJSON("/api/runner/status");

    const runnerBox = $("runnerInfo");
    if (runnerBox) {
      const market = r.market || {};
      const universe = r.universe || {};
      runnerBox.innerHTML = `
        <div><b>Enabled:</b> ${r.enabled ? "YES" : "NO"}</div>
        <div><b>Interval:</b> ${r.intervalSec ?? "—"}s</div>
        <div><b>Market:</b> ${market.open ? "OPEN" : "CLOSED"} (${market.reason || "—"})</div>
        <div><b>News-only when closed:</b> ${r.newsOnlyWhenClosed ? "YES" : "NO"}</div>
        <div><b>Universe:</b> ${universe.mode || "—"}${universe.mode==="custom" ? ` (${(universe.custom||[]).length})` : ""}</div>
        <div><b>Last symbol:</b> ${r.state?.lastSymbol || "—"}</div>
        <div><b>Next symbol:</b> ${r.nextSymbol || "—"}</div>
      `;
    }

    if ($("carouselSymbol")) $("carouselSymbol").textContent = r.state?.lastSymbol || "—";
  } catch {}
}

async function backfillEvents() {
  const box = $("eventStream");
  if (!box) return;

  const lastSeen = Number(localStorage.getItem("warroom_last_event_id") || 0);

  try {
    const r = await getJSON(`/api/events/recent?limit=160&afterId=${lastSeen}`);
    const items = r.items || [];

    if (!items.length) return;

    for (const msg of items) {
      if (msg.id) localStorage.setItem("warroom_last_event_id", String(msg.id));
      $("lastEvent").textContent = `${msg.type} • ${fmtTime(msg.ts)}`;
      if (msg.type === "carousel_tick") $("carouselSymbol").textContent = msg.payload?.symbol || "—";
      pushEventLine(formatEvent(msg), msg.ts);
    }
  } catch {}
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
      $("lastEvent").textContent = `${msg.type} • ${fmtTime(msg.ts)}`;

      if (msg.type === "carousel_tick") {
        $("carouselSymbol").textContent = msg.payload?.symbol || "—";
      }

      if (msg.id) localStorage.setItem("warroom_last_event_id", String(msg.id));
      pushEventLine(formatEvent(msg), msg.ts);

      // if runner ticks, refresh panels
      if (msg.type === "carousel_tick" || msg.type === "bot_fight") {
        await refreshWarRoom();
      }
    } catch {}
  };

  return ws;
}

// boot
(async function init() {
  setWsStatus("WS: connecting…");
  await refreshWarRoom();
  await backfillEvents();
  connectWS();

  // keep UI fresh even if WS is down
  setInterval(() => refreshWarRoom().catch(() => {}), 12000);
  setInterval(() => backfillEvents().catch(() => {}), 6000);
})();
