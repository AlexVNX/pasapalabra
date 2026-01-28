import { officialDeckId, listCards } from "../state/deck.js";
import { get, put } from "../state/db.js";
import { defaultProgress, applyReview } from "../engine/srs.js";
import { normalizeAnswer } from "../engine/normalize.js";

export async function renderStudy(root){
  const deckId = officialDeckId();
  const cards = await listCards(deckId);

  // Candidatas: due o nuevas
  const now = Date.now();
  const candidates = [];
  for (const c of cards) {
    const key = `${deckId}:${c.cardId}`;
    const prog = (await get("progress", key)) || defaultProgress(deckId, c.cardId);
    const isDue = prog.dueAt !== 0 && prog.dueAt <= now;
    const isNew = prog.dueAt === 0;
    if (isDue || isNew) candidates.push({ c, prog });
  }

  let idx = 0;
  let showAnswer = false;

  const render = () => {
    const item = candidates[idx];
    if (!item) {
      root.innerHTML = `
        <div class="card">
          <h2>Repaso</h2>
          <p>Hoy no tienes tarjetas pendientes. Vuelve mañana y serás una persona ligeramente más peligrosa (intelectualmente).</p>
          <a class="btn primary" href="#/">Volver</a>
        </div>`;
      return;
    }

    root.innerHTML = `
      <div class="card">
        <div class="row">
          <h2 style="margin:0">Repaso (SRS)</h2>
          <div class="spacer"></div>
          <span class="pill">${idx+1}/${candidates.length}</span>
        </div>

        <p style="margin-top:10px; color:var(--muted)">Pregunta</p>
        <h3>${escapeHtml(item.c.question)}</h3>

        <div style="margin-top:12px">
          <button class="btn" id="toggle">${showAnswer ? "Ocultar respuesta" : "Ver respuesta"}</button>
        </div>

        ${showAnswer ? `
          <div style="margin-top:14px; padding-top:14px; border-top:1px solid rgba(37,49,79,.6)">
            <p style="margin-bottom:6px; color:var(--muted)">Respuesta</p>
            <h3>${escapeHtml(item.c.answer)}</h3>
            ${item.c.explanation ? `<p>${escapeHtml(item.c.explanation)}</p>` : ``}

            <div class="row" style="margin-top:12px">
              <button class="btn bad" data-grade="0">Otra vez</button>
              <button class="btn" data-grade="1">Difícil</button>
              <button class="btn good" data-grade="2">Bien</button>
              <button class="btn primary" data-grade="3">Fácil</button>
            </div>
          </div>
        ` : ``}
      </div>
    `;

    root.querySelector("#toggle")?.addEventListener("click", () => {
      showAnswer = !showAnswer;
      render();
    });

    root.querySelectorAll("[data-grade]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const grade = Number(btn.getAttribute("data-grade"));
        const updated = applyReview(item.prog, grade);
        await put("progress", updated);

        idx += 1;
        showAnswer = false;
        render();
      });
    });
  };

  render();
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
