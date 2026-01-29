import { getNick, setNick, fetchTopScores } from "../state/ranking.js";

export async function renderRanking(root) {
  const api = (localStorage.getItem("ec_api") || "").trim();
  let nick = getNick();
  let mode = "delta";
  let items = [];

  root.innerHTML = `
    <section class="grid cols2">
      <div class="card">
        <h2 style="margin:0 0 8px">Ranking</h2>
        <p>Nick local (no hace falta login). El score se sube al terminar una partida.</p>

        <div style="margin-top:12px">
          <label style="display:block; margin-bottom:6px; color:var(--muted); font-weight:700;">Tu nick</label>
          <input class="input" id="nick" placeholder="Ej: Belay88" value="${escapeHtml(nick)}" />
        </div>

        <div style="margin-top:12px">
          <label style="display:block; margin-bottom:6px; color:var(--muted); font-weight:700;">Endpoint API (Cloudflare/Supabase)</label>
          <input class="input" id="api" placeholder="https://tu-api.workers.dev" value="${escapeHtml(api)}" />
          <p style="font-size:13px; margin-top:8px">Si está vacío, verás el ranking vacío (pero se sigue guardando la cola offline de eventos).</p>
        </div>

        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="save">Guardar</button>
          <button class="btn" id="reload">Recargar</button>
          <div class="spacer"></div>
          <span class="pill">Modo: <b>${escapeHtml(mode)}</b></span>
        </div>
      </div>

      <div class="card">
        <h3>Top jugadores</h3>
        <div id="list" style="margin-top:10px">
          <p style="color:var(--muted)">Cargando…</p>
        </div>
      </div>
    </section>
  `;

  root.querySelector("#save")?.addEventListener("click", () => {
    const n = (root.querySelector("#nick")?.value || "").trim();
    const a = (root.querySelector("#api")?.value || "").trim();

    setNick(n);
    try { localStorage.setItem("ec_api", a); } catch {}
    renderRanking(root);
  });

  root.querySelector("#reload")?.addEventListener("click", async () => {
    await load();
  });

  await load();

  async function load() {
    const apiNow = (localStorage.getItem("ec_api") || "").trim();
    const list = root.querySelector("#list");
    if (!list) return;

    if (!apiNow) {
      list.innerHTML = `<p style="color:var(--muted)">No hay endpoint configurado. Pon uno arriba para ver ranking.</p>`;
      return;
    }

    list.innerHTML = `<p style="color:var(--muted)">Cargando…</p>`;
    items = await fetchTopScores(apiNow, { mode, limit: 50 });

    if (!items.length) {
      list.innerHTML = `<p style="color:var(--muted)">No hay datos todavía (o el endpoint no responde).</p>`;
      return;
    }

    list.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:8px">
        ${items.map((it, idx) => `
          <div class="pill" style="justify-content:space-between; gap:12px">
            <span><b>#${idx + 1}</b> ${escapeHtml(it.nick || "Anónimo")}</span>
            <span><b>${Number(it.score || 0)}</b></span>
          </div>
        `).join("")}
      </div>
    `;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
