// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { dbInit, hasDb, dbQuery } from "./db.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function wsBroadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(msg);
  }
}

async function emitEvent(type, payload) {
  const evt = { type, ts: new Date().toISOString(), payload };
  try {
    if (hasDb) {
      const r = await dbQuery(
        `INSERT INTO events(type,payload) VALUES($1,$2::jsonb) RETURNING id,ts`,
        [type, JSON.stringify(payload)]
      );
      evt.id = r.rows[0].id;
      evt.ts = r.rows[0].ts;
    }
  } catch (e) {
    console.error("Event persist error:", e.message);
  }
  wsBroadcast(evt);
}

process.on("unhandledRejection", (e) => {
  emitEvent("fatal_error", { error: String(e) });
});
process.on("uncaughtException", (e) => {
  emitEvent("fatal_error", { error: String(e) });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    postgres: hasDb,
    ts: new Date().toISOString()
  });
});

(async function boot() {
  try {
    await dbInit();
    await emitEvent("server_booted", { phase: "A" });
  } catch (e) {
    console.error("Boot error:", e.message);
  }

  server.listen(process.env.PORT || 3000, () => {
    console.log("Server up");
  });
})();
