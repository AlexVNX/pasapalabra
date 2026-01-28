import { listDecks, officialDeckId } from "../state/deck.js";

export async function renderHome(root){
  const decks = await listDecks();

  root.innerHTML = `
    <section class="grid cols2">
      <div class="card">
        <h1>EntrenaCoco</h1>
        <p>Dos modos: <b>Repaso</b> (memoria real con repetición espaciada) y <b>Pasapalabra</b> (juego + SRS para que no sea repetitivo).</p>
        <div class="row">
          <a class="btn primary" href="#/study">Empezar repaso</a>
          <a class="btn" href="#/pasapalabra">Jugar</a>
          <a class="btn" href="#/editor">Crear tarjetas</a>
        </div>
      </div>

      <div class="card">
        <h2>Mazos disponibles</h2>
        <p>El oficial viene del fichero <code>/decks/oficiales.es.json</code>.</p>
        <div class="row">
          <span class="pill">Oficial: <b>${officialDeckId()}</b></span>
        </div>
        <div style="margin-top:12px">
          ${decks.map(d => `
            <div class="pill" style="margin:6px 6px 0 0">
              <b>${escapeHtml(d.title || d.id)}</b>
              <span style="opacity:.75">· ${escapeHtml(d.kind)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
