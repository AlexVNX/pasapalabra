import { officialDeckId, listCards } from "../state/deck.js";
import { get, put } from "../state/db.js";
import { defaultProgress, applyReview, scoreForGame } from "../engine/srs.js";
import { normalizeAnswer } from "../engine/normalize.js";

const LETTERS = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ".split("");

export async function renderPasapalabra(root){
  const deckId = officialDeckId();
  const all = await listCards(deckId);

  // Construir “banco” por letra: tarjeta que empiece por esa letra en la respuesta (o pregunta si prefieres)
  const byLetter = new Map();
  for (const L of LETTERS) byLetter.set(L, []);

  for (const c of all) {
    const a = normalizeAnswer(c.answer);
    const first = a[0]?.toUpperCase() || "";
    // Convertimos ñ normalizada a n, así que detectamos Ñ por original también
    const rawFirst = (c.answer || "").trim().toUpperCase()[0] || "";
    const letter = (rawFirst === "Ñ") ? "Ñ" : first;
    if (byLetter.has(letter)) byLetter.get(letter).push(c);
  }

  // Estado de ronda
  let timeLeft = 120; // 2 min default
  let timer = null;
  const states = {}; // L -> new|ok|fail|skip
  LETTERS.forEach(L => states[L] = "new");

  // Elegir letra actual: primera con contenido
  let currentLetter = firstPlayableLetter(byLetter);

  // Pregunta actual
  let current = null;

  const start = async () => {
    current = await pickCardForLetter(deckId, byLetter, currentLetter);
    render();
    timer = setInterval(() => {
      timeLeft -= 1;
      if (timeLeft <= 0) {
        timeLeft = 0;
        clearInterval(timer);
        timer = null;
      }
      updateHeaderTime();
      if (timeLeft === 0) render(); // bloquea acciones
    }, 1000);
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const nextLetter = () => {
    const idx = LETTERS.indexOf(currentLetter);
    for (let step=1; step<=LETTERS.length; step++){
      const L = LETTERS[(idx+step) % LETTERS.length];
      if (byLetter.get(L)?.length) {
        currentLetter = L;
        return;
      }
    }
  };

  const render = () => {
    const playable = byLetter.get(currentLetter)?.length > 0;
    const ended = timeLeft === 0 || allDone(states, byLetter);

    root.innerHTML = `
      <section class="grid cols2">
        <div class="card">
          <div class="row">
            <h2 style="margin:0">Pasapalabra (con SRS)</h2>
            <div class="spacer"></div>
            <span class="pill">Tiempo: <b id="t">${fmt(timeLeft)}</b></span>
          </div>

          <p style="margin-top:10px">
            Letra actual: <span class="pill"><b>${currentLetter}</b></span>
          </p>

          ${!playable ? `
            <p>No hay tarjetas para esta letra en el mazo oficial. (En el editor puedes añadir.)</p>
          ` : ended ? `
            <h3>Fin de ronda</h3>
            <p>Resumen: ${summary(states)}</p>
            <div class="row">
              <button class="btn primary" id="restart">Jugar otra ronda</button>
              <a class="btn" href="#/study">Ir a repaso</a>
            </div>
          ` : `
            <p style="margin-top:10px; color:var(--muted)">Definición</p>
            <h3>${escapeHtml(current?.question || "Cargando...")}</h3>

            ${current?.hint ? `<p><span class="pill">Pista</span> ${escapeHtml(current.hint)}</p>` : ``}

            <div style="margin-top:12px">
              <input class="input" id="ans" placeholder="Escribe la respuesta…" autocomplete="off" />
            </div>

            <div class="row" style="margin-top:12px">
              <button class="btn good" id="ok">Responder</button>
              <button class="btn" id="skip">Pasapalabra</button>
              <button class="btn bad" id="fail">Fallo</button>
            </div>

            <p style="margin-top:10px; color:var(--muted)">
              Regla anti-aburrimiento: el juego prioriza tarjetas nuevas o vencidas y evita repetir las recién vistas.
            </p>
          `}
        </div>

        <div class="card">
          <h3>Rosco triangular</h3>
          <p>Minimalista, pero con feedback visual.</p>

          <div class="legend">
            <span class="pill"><span class="dot new"></span> Pendiente</span>
            <span class="pill"><span class="dot ok"></span> Acierto</span>
            <span class="pill"><span class="dot fail"></span> Fallo</span>
            <span class="pill"><span class="dot" style="background:var(--muted)"></span> Pasada</span>
          </div>

          <div class="roscoWrap">
            ${triangleSVG(states, currentLetter, byLetter)}
          </div>
        </div>
      </section>
    `;

    // Handlers
    root.querySelector("#restart")?.addEventListener("click", () => location.reload());

    if (!ended && playable) {
      const input = root.querySelector("#ans");
      input?.focus();

      const act = async (type) => {
        if (timeLeft === 0) return;

        if (type === "ok") {
          const given = normalizeAnswer(input.value);
          const correct = normalizeAnswer(current.answer);

          const isOk = given && (given === correct);
          if (isOk) {
            states[currentLetter] = "ok";
            await reviewCard(deckId, current.cardId, 2); // bien
          } else {
            // respuesta incorrecta -> fallo (pero no “castigamos” igual que 0 en repaso)
            states[currentLetter] = "fail";
            await reviewCard(deckId, current.cardId, 0);
          }
        }

        if (type === "fail") {
          states[currentLetter] = "fail";
          await reviewCard(deckId, current.cardId, 0);
        }

        if (type === "skip") {
          states[currentLetter] = "skip";
          // skip: no actualiza SRS (o podríamos darle un 1 si quieres)
        }

        nextLetter();
        current = await pickCardForLetter(deckId, byLetter, currentLetter);
        render();
      };

      root.querySelector("#ok")?.addEventListener("click", () => act("ok"));
      root.querySelector("#fail")?.addEventListener("click", () => act("fail"));
      root.querySelector("#skip")?.addEventListener("click", () => act("skip"));

      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") act("ok");
      });
    }
  };

  await start();

  // Cleanup si cambias de ruta
  window.addEventListener("hashchange", () => stop(), { once:true });
}

async function pickCardForLetter(deckId, byLetter, letter){
  const pool = byLetter.get(letter) || [];
  if (!pool.length) return null;

  // Scoring por SRS para no repetir y priorizar due/nuevas
  const scored = [];
  for (const c of pool) {
    const key = `${deckId}:${c.cardId}`;
    const prog = (await get("progress", key)) || defaultProgress(deckId, c.cardId);
    const s = scoreForGame(prog);
    scored.push({ c, s });
  }

  // Ruleta ponderada
  const total = scored.reduce((a,x) => a + x.s, 0);
  let r = Math.random() * total;
  for (const x of scored) {
    r -= x.s;
    if (r <= 0) return x.c;
  }
  return scored[0].c;
}

async function reviewCard(deckId, cardId, grade){
  const key = `${deckId}:${cardId}`;
  const prog = (await get("progress", key)) || defaultProgress(deckId, cardId);
  const updated = applyReview(prog, grade);
  await put("progress", updated);
}

function firstPlayableLetter(byLetter){
  for (const L of LETTERS) if (byLetter.get(L)?.length) return L;
  return LETTERS[0];
}

function allDone(states, byLetter){
  // Termina cuando todas las letras con pool están ok/fail (skip no cuenta como terminada)
  for (const [L, pool] of byLetter.entries()){
    if (!pool?.length) continue;
    if (states[L] === "new" || states[L] === "skip") return false;
  }
  return true;
}

function summary(states){
  const vals = Object.values(states);
  const ok = vals.filter(x => x==="ok").length;
  const fail = vals.filter(x => x==="fail").length;
  const skip = vals.filter(x => x==="skip").length;
  return `${ok} aciertos · ${fail} fallos · ${skip} pasadas`;
}

function fmt(sec){
  const m = Math.floor(sec/60);
  const s = sec%60;
  return `${m}:${String(s).padStart(2,"0")}`;
}

function updateHeaderTime(){
  const t = document.getElementById("t");
  if (t) t.textContent = fmt(Number(t.textContent?.includes(":") ? 0 : 0)); // noop safe
  // (se actualiza realmente re-renderizando al final; esto es solo “suave”)
}

function triangleSVG(states, currentLetter, byLetter){
  // 3 filas para que parezca “triángulo”: 9 + 9 + 9 (aprox). Tenemos 27 letras.
  const rows = [LETTERS.slice(0,9), LETTERS.slice(9,18), LETTERS.slice(18,27)];
  const cell = 28;
  const pad = 12;
  const w = pad*2 + 9*cell;
  const h = pad*2 + 3*cell;

  const color = (L) => {
    if (!(byLetter.get(L)?.length)) return "rgba(168,178,209,.18)";
    if (L === currentLetter) return "rgba(91,124,250,.55)";
    const st = states[L];
    if (st === "ok") return "rgba(53,208,127,.55)";
    if (st === "fail") return "rgba(255,90,122,.55)";
    if (st === "skip") return "rgba(168,178,209,.35)";
    return "rgba(255,204,102,.45)";
  };

  let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Rosco triangular">`;
  rows.forEach((r, i) => {
    const offset = (i * 0); // si quieres centrar más, puedes sumar (i*cell/2)
    r.forEach((L, j) => {
      const x = pad + j*cell + offset;
      const y = pad + i*cell;
      svg += `
        <g>
          <rect x="${x}" y="${y}" width="${cell-4}" height="${cell-4}" rx="10"
            fill="${color(L)}" stroke="rgba(37,49,79,.85)" />
          <text x="${x + (cell-4)/2}" y="${y + 16}" text-anchor="middle" class="letter"
            fill="rgba(233,238,252,.92)">${L}</text>
        </g>`;
    });
  });
  svg += `</svg>`;
  return svg;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
