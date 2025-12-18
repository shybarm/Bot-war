// public/war-room.js
const $ = (id) => document.getElementById(id);

function setWsStatus(txt) {
  $("wsStatus").textContent = txt;
}

function fmtTime(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleTimeString(); } catch { return "—"; }
}

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(j.error || t || "Request failed");
  return j;
}

function bankrollCardRow(p) {
  const cash = Number(p.cash || 0);
  const goal = Number(p.goal || 150000);
  const pct = goal ? Math.max(0, Math.min(100, (cash / goal) * 100)) : 0;

  return `
    <div class="glass rounded-2xl p-3 cursor-pointer hover:opacity-90" data-bot="${p.bot}">
      <div class="flex items-center justify-between">
        <div class="font-extrabold">${p.bot}</div>
        <div class="text-xs muted">$${cash.toFixed(0)}</div>
      </div>
      <div class="mt-2 h-2 rounded-full bg-white/10 overflow-hidden">
        <div class="h-full bg-emerald-300/80" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <div class="mt-2 text-xs muted">${pct.toFixed(1)}% to goal</div>
    </div>
  `;
}

function renderBankroll(items) {
  const box = $("bankrollGrid");
  if (!items || !items.length) {
    box.innerHTML = `<div class="muted text-sm">No portfolios yet (runner will create them).</div>`;
    return;
  }
  box.innerHTML = items.map(bankrollCardRow).join("");
  box.querySelectorAll("[data-bot]").forEach((el) => {
    el.addEventListener("click", () => openDrawer(el.getAttribute("data-bot")));
  });
}

function renderTrades(items) {
  const tb = $("tradeStreamBody");
  if (!items || !items.length) {
    tb.innerHTML = `<tr><td class="p-3 muted" colspan="7">—</td></tr>`;
    return;
  }
  tb.innerHTML = items.map((t) => `
    <tr class="border-t border-white/10">
      <td class="p-3 text-xs muted">${fmtTime(t.ts)}</td>
      <td class="p-3">${t.bot}</td>
      <td class="p-3">${t.side}</td>
      <td class="p-3">${t.symbol}</td>
      <td class="p-3">${Number(t.qty || 0).toFixed(0)}</td>
      <td class="p-3">$${Number(t.price || 0).toFixed(2)}</td>
      <td class="p-3 text-xs muted" title="${(t.rationale || "").replaceAll('"','&quot;')}">${(t.rationale || "").slice(0, 120)}</td>
    </tr>
  `).join("");
}

function pushEventLine(text, ts) {
  const box = $("eventStream");
  const div = document.createElement("div");
  div.className = "muted";
  div.textContent = `${fmtTime(ts)}  ${text}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function formatEvent(msg) {
  if (msg.type === "carousel_tick") {
    const m = msg.payload?.market;
    return `♻ Carousel → ${msg.payload?.symbol} • Market: ${m?.open ? "OPEN" : "CLOSED"} (${m?.reason || ""})`;
  }
  if (msg.type === "bot_fight") {
    return `⚔️ Fight: ${msg.payload?.symbol} • winner=${msg.payload?.winner} • trades=${msg.payload?.tradesAllowed ? "YES" : "NO"} • news=${msg.payload?.features?.newsProvider || "—"}`;
  }
  if (msg.type === "trade_recorded") {
    return `💸 Trade: ${msg.payload?.bot} ${msg.payload?.side} ${msg.payload?.symbol} @ ${msg.payload?.price}`;
  }
  if (msg.type === "learning_evaluated") {
    return `🧠 Learning evaluated: ${msg.payload?.evaluated || 0} samples`;
  }
  if (msg.type === "server_booted") {
    return `✅ Server booted (${msg.payload?.version || ""})`;
  }
  if (msg.type === "runner_error") {
    return `⚠ Runner error: ${msg.payload?.symbol || ""} • ${msg.payload?.error || ""}`;
  }
  return `${msg.type}`;
}

// Hydrate from DB so refresh doesn’t “start over”
async function hydrateEventsFromDb() {
  const box = $("eventStream");
  box.innerHTML = `<div class="muted">Loading events…</div>`;

  const lastSeen = Number(localStorage.getItem("warroom_last_event_id") || 0);
  const r = await getJSON(`/api/events/recent?limit=180&afterId=${lastSeen}`);
  const items = r.items || [];

  if (!items.length) {
    box.innerHTML = `<div class="muted">Waiting for events…</div>`;
    return;
  }

  box.innerHTML = "";
  for (const e of items) {
    pushEventLine(formatEvent(e), e.ts);
    if (e.id) localStorage.setItem("warroom_last_event_id", String(e.id));
  }
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setWsStatus("WS: live ✅");
  ws.onclose = () => setWsStatus("WS: closed ⚠️");
  ws.onerror = () => setWsStatus("WS: error ⚠️");

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      $("lastEvent").textContent = formatEvent(msg);
      if (msg.type === "carousel_tick") $("curSymbol").textContent = msg.payload?.symbol || "—";
      pushEventLine(formatEvent(msg), msg.ts);

      // refresh key panels on high-signal events
      if (["trade_recorded", "bot_fight", "runner_state"].includes(msg.type)) {
        await refreshPanels();
      }
    } catch {}
  };
}

async function refreshPanels() {
  // Each block is isolated so one failure doesn’t kill the page
  try {
    const p = await getJSON("/api/portfolios");
    renderBankroll(p.items || []);
  } catch {}

  try {
    const t = await getJSON("/api/trades/recent?limit=25");
    renderTrades(t.items || []);
  } catch (e) {
    // show the error in the table so it’s visible
    $("tradeStreamBody").innerHTML = `<tr><td class="p-3 muted" colspan="7">Trades error: ${String(e.message || e)}</td></tr>`;
  }

  try {
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
  } catch {
    $("runnerInfo").textContent = "Runner status unavailable.";
  }
}

// Drawer
function openDrawer(bot) {
  $("drawerBack").classList.remove("hidden");
  $("drawer").classList.remove("translate-x-full");
  $("drawerTitle").textContent = `Bot: ${bot}`;
  $("drawerSub").textContent = "Trade history";

  loadDrawer(bot);
}

function closeDrawer() {
  $("drawerBack").classList.add("hidden");
  $("drawer").classList.add("translate-x-full");
}

async function loadDrawer(bot) {
  const body = $("drawerBody");
  body.innerHTML = `<tr><td class="py-3 muted" colspan="5">Loading…</td></tr>`;

  try {
    const out = await getJSON(`/api/trades/bot/${encodeURIComponent(bot)}?limit=120`);
    const items = out.items || [];
    if (!items.length) {
      body.innerHTML = `<tr><td class="py-3 muted" colspan="5">No trades yet.</td></tr>`;
      return;
    }
    body.innerHTML = items.map((t) => `
      <tr class="border-t border-white/10">
        <td class="py-2 text-xs muted">${fmtTime(t.ts)}</td>
        <td class="py-2">${t.side}</td>
        <td class="py-2">${t.symbol}</td>
        <td class="py-2">${Number(t.qty || 0).toFixed(0)}</td>
        <td class="py-2">$${Number(t.price || 0).toFixed(2)}</td>
      </tr>
    `).join("");
  } catch (e) {
    body.innerHTML = `<tr><td class="py-3 muted" colspan="5">Error: ${String(e.message || e)}</td></tr>`;
  }
}

$("drawerClose").onclick = closeDrawer;
$("drawerBack").onclick = closeDrawer;

// Boot
(async function boot() {
  await hydrateEventsFromDb();
  await refreshPanels();
  connectWS();

  // periodic refresh as safety net
  setInterval(refreshPanels, 7000);
})();
