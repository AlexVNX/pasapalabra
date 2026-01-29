import { add, getAll, del } from "./db.js";
import { submitScoreFromGameEnd } from "./ranking.js";

let API = "";
let flushTimer = null;

export function initTelemetry({ endpoint = "" } = {}) {
  API = (endpoint || "").trim();

  // Escucha eventos del juego
  window.addEventListener("ec_event", async (e) => {
    const detail = e?.detail || {};
    const name = detail.name || "unknown";
    const payload = detail.payload || {};
    const ts = detail.ts || Date.now();

    // Guardar en cola local siempre
    try {
      await add("events", { ts, name, payload });
    } catch {
      // ignore
    }

    // Si es fin de partida, intenta mandar score (ranking)
    if (name === "game_end") {
      try { await submitScoreFromGameEnd(payload, API); } catch {}
    }

    // Flush “suave”
    scheduleFlush(1200);
  });

  // Flush cuando el usuario vuelve a la pestaña
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleFlush(400);
  });

  // Flush periódico
  flushTimer = setInterval(() => flushNow().catch(() => {}), 12_000);
}

function scheduleFlush(ms) {
  setTimeout(() => flushNow().catch(() => {}), ms);
}

async function flushNow() {
  if (!API) return; // sin endpoint: solo cola local

  const items = await getAll("events");
  if (!items.length) return;

  // Batch máximo (no te vayas loco)
  const batch = items.slice(0, 50);

  const ok = await postJson(`${API}/api/events`, { events: batch });
  if (!ok) return;

  // Si se envió bien, borramos esos ids
  for (const it of batch) {
    try { await del("events", it.id); } catch {}
  }
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true
    });
    return res.ok;
  } catch {
    return false;
  }
}
