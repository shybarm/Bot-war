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

  // keep last 80
  while (box.children.length > 80) box.removeChild(box.lastChild);
}

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
      <div class="chip rounded-2xl p-4">
        <div class="flex items-center justify-between">
          <div class="font-semibold">${p.bot}</div>
          <div class="text-xs muted">$${cash.toFixed(2)}</div>
        </div>
        <div class="mt-3 h-2 rounded-full bg-white/10 overflow-hidden">
          <div style="width:${pct}%" class="h-2 bg-gradient-to-r from-indigo-500 to-fuchsia-500"></div>
        </div>
        <div class="mt-2 text-xs muted">Progress to $${goal.toFixed(0)} • ${pct.toFixed(1)}%</div>
      </div>
    `;
  }).join("");
}

async function refreshWarRoom() {
  const p = await getJSON("/api/portfolios");
  renderBankroll(p.items || []);

  const t = await getJSON("/api/trades/recent?limit=25");
  renderTrades(t.items || []);
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
        pushEventLine(`♻ Carousel: ${msg.payload?.symbol}`);
      }

      if (msg.type === "bot_fight") {
        const sym = msg.payload?.symbol;
        const winner = msg.payload?.winner;
        pushEventLine(`⚔️ Fight: ${sym} • winner=${winner}`);
        await refreshWarRoom();
      }

      if (msg.type === "learning_evaluated") {
        pushEventLine(`🧠 Learning evaluated: ${msg.payload?.evaluated || 0} samples`);
      }
    } catch {}
  };

  return ws;
}

(async function init() {
  await refreshWarRoom();
  connectWS();

  // keep the page fresh even if no WS events
  setInterval(() => refreshWarRoom().catch(() => {}), 15000);
})();
