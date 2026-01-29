import { mountRoute } from "./router.js";
import { setStatus, setActiveTab } from "./ui.js";
import { initDB } from "./state/db.js";
import { ensureOfficialDeckLoaded } from "./state/deck.js";
import { initTelemetry } from "./state/telemetry.js";

async function boot() {
  setStatus("Inicializando...");
  await initDB();
  await ensureOfficialDeckLoaded();

  // Telemetría + ranking (backend mínimo)
  initTelemetry({
    // IMPORTANTE:
    // Pon aquí tu endpoint de Cloudflare Worker (o Supabase) cuando lo tengas.
    // Ej: "https://entrenacoco-api.tudominio.workers.dev"
    endpoint: localStorage.getItem("ec_api") || ""
  });

  setStatus("Listo.");

  // Router
  window.addEventListener("hashchange", () => {
    setActiveTab(location.hash || "#/");
    mountRoute();
  });

  setActiveTab(location.hash || "#/");
  mountRoute();

  // PWA
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      // Si falla, no pasa nada: sigue siendo web.
    }
  }
}

boot();
