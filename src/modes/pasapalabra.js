import { officialDeckId, listCards } from "../state/deck.js";
import { get, put } from "../state/db.js";
import { defaultProgress, applyReview, scoreForGame } from "../engine/srs.js";
import { normalizeAnswer } from "../engine/normalize.js";

const LETTERS = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ".split("");

// ====== Config por defecto (puedes exponerlo luego en UI) ======
const DEFAULT_TIME_SEC = 120;
const FUZZY_THRESHOLD = 0.86; // 0..1 (más alto = más estricto)
const ALLOW_CONTAINS_FOR_NAMES = true; // permite "cervantes" vs "miguel de cervantes"

// ====== Modo principal ======
export async function renderPasapalabra(root) {
  const deckId = officialDeckId();
  const all = await listCards(deckId);

  // Banco por letra según primera letra de la RESPUESTA (tal cual lo querías para “triángulo”)
  const byLetter = buildByLetter(all);

  // Estado de ronda
  let timeLeft = DEFAULT_TIME_SEC;
  let timer = null;

  // Estado por letra: new | ok | fail | skip
  const states = Object.fromEntries(LETTERS.map((L) => [L, "new"]));

  // Letra actual: primera que tenga contenido
  let currentLetter = firstPlayableLetter(byLetter);
  let currentCard = null;

  // Estado de UI / control
  let pausedByKO = false; // al fallar, se pausa y hay que pulsar “Continuar”
  let lastKO = null; // { correctAnswer, given, letter }
  let voiceSupported = isSpeechRecognitionSupported();
  let ttsSupported = "speechSynthesis" in window;

  // Speech Recognition
  let recognition = null;
  let isListening = false;

  // ====== Boot ======
  currentCard = await pickCardForLetter(deckId, byLetter, currentLetter);

  startTimer();

  render();

  // Cleanup si cambias ruta
  window.addEventListener(
    "hashchange",
    () => {
      stopTimer();
      stopListening();
    },
    { once: true }
  );

  // ====== Timer ======
  function startTimer() {
    stopTimer();
    timer = setInterval(() => {
      if (pausedByKO) return;
      if (timeLeft <= 0) return;

      timeLeft -= 1;
      if (timeLeft < 0) timeLeft = 0;

      const tEl = root.querySelector("#t");
      if (tEl) tEl.textContent = fmt(timeLeft);

      if (timeLeft === 0) {
        stopListening();
        render();
      }
    }, 1000);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ====== Voice ======
  function isSpeechRecognitionSupported() {
    return (
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
    );
  }

  function initRecognition() {
    if (!voiceSupported) return null;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = "es-ES";
    rec.interimResults = false;
    rec.maxAlternatives = 3;

    rec.onresult = (e) => {
      const txt =
        e.results?.[0]?.[0]?.transcript?.trim?.() ??
        e.results?.[0]?.transcript?.trim?.() ??
        "";
      const input = root.querySelector("#ans");
      if (input && txt) input.value = txt;
      // Auto-responder si hay texto (como “programa de la tele”)
      if (txt) actAnswer("ok");
    };

    rec.onend = () => {
      isListening = false;
      const btn = root.querySelector("#voiceBtn");
      if (btn) btn.textContent = "🎙️ Voz";
    };

    rec.onerror = () => {
      isListening = false;
      const btn = root.querySelector("#voiceBtn");
      if (btn) btn.textContent = "🎙️ Voz";
    };

    return rec;
  }

  function toggleListening() {
    if (!voiceSupported) return;
    if (timeLeft === 0) return;
    if (pausedByKO) return;

    if (!recognition) recognition = initRecognition();

    if (!recognition) return;

    if (isListening) {
      stopListening();
      return;
    }

    try {
      isListening = true;
      const btn = root.querySelector("#voiceBtn");
      if (btn) btn.textContent = "🛑 Parar";
      recognition.start();
    } catch {
      isListening = false;
    }
  }

  function stopListening() {
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      // ignore
    }
    isListening = false;
    const btn = root.querySelector("#voiceBtn");
    if (btn) btn.textContent = "🎙️ Voz";
  }

  function speak(text) {
    if (!ttsSupported) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "es-ES";
      // Cancela cola para que no se solape
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      // ignore
    }
  }

  // ====== Game flow ======
  function ended() {
    return timeLeft === 0 || allDone(states, byLetter);
  }

  function nextLetter() {
    const idx = LETTERS.indexOf(currentLetter);
    for (let step = 1; step <= LETTERS.length; step++) {
      const L = LETTERS[(idx + step) % LETTERS.length];
      if (byLetter.get(L)?.length) {
        currentLetter = L;
        return;
      }
    }
  }

  async function goNext() {
    nextLetter();
    currentCard = await pickCardForLetter(deckId, byLetter, currentLetter);
    render();
  }

  async function actAnswer(type) {
    if (timeLeft === 0) return;
    if (ended()) return;
    if (pausedByKO) return;

    const input = root.querySelector("#ans");
    const givenRaw = input ? input.value : "";

    if (type === "skip") {
      states[currentLetter] = "skip";
      // skip: no tocamos SRS
      await goNext();
      return;
    }

    if (type === "fail") {
      // KO manual: muestra correcta, pausa hasta “Continuar”
      states[currentLetter] = "fail";
      await reviewCard(deckId, currentCard.cardId, 0);
      beepKO();
      pausedByKO = true;
      lastKO = {
        correctAnswer: currentCard.answer,
        given: "",
        letter: currentLetter
      };
      stopListening();
      render();
      return;
    }

    // type === "ok": comparar
    const correct = currentCard?.answer ?? "";
    const res = compareAnswers(givenRaw, correct);

    if (res.ok) {
      states[currentLetter] = "ok";
      await reviewCard(deckId, currentCard.cardId, 2); // "bien"
      beepOK();
      stopListening();
      await goNext();
      return;
    }

    // KO: pausa + feedback (y no pasas a la siguiente hasta pulsar continuar)
    states[currentLetter] = "fail";
    await reviewCard(deckId, currentCard.cardId, 0);
    beepKO();
    pausedByKO = true;
    lastKO = {
      correctAnswer: correct,
      given: givenRaw,
      letter: currentLetter
    };
    stopListening();
    render();
  }

  async function continueAfterKO() {
    pausedByKO = false;
    lastKO = null;
    // limpiamos input
    const input = root.querySelector("#ans");
    if (input) input.value = "";
    await goNext();
  }

  function restartRound() {
    stopTimer();
    stopListening();

    timeLeft = DEFAULT_TIME_SEC;
    pausedByKO = false;
    lastKO = null;

    for (const L of LETTERS) states[L] = "new";
    currentLetter = firstPlayableLetter(byLetter);

    pickCardForLetter(deckId, byLetter, currentLetter).then((c) => {
      currentCard = c;
      startTimer();
      render();
    });
  }

  // ====== Render ======
  function render() {
    const playable = byLetter.get(currentLetter)?.length > 0;

    const centerText = currentCard?.question || "—";
    const showKO = pausedByKO && lastKO;

    root.innerHTML = `
      <section class="grid cols2">
        <div class="card">
          <div class="row">
            <h2 style="margin:0">Triángulo de letras</h2>
            <div class="spacer"></div>
            <span class="pill">Tiempo: <b id="t">${fmt(timeLeft)}</b></span>
          </div>

          <p style="margin-top:10px">
            Letra actual: <span class="pill"><b>${escapeHtml(currentLetter)}</b></span>
          </p>

          ${
            !playable
              ? `<p>No hay tarjetas para esta letra en el mazo. Añade en el fichero oficial o en el editor.</p>`
              : ended()
              ? `
                <h3>Fin de ronda</h3>
                <p>Resumen: ${summary(states)}</p>
                <div class="row">
                  <button class="btn primary" id="restart">Jugar otra ronda</button>
                  <a class="btn" href="#/study">Ir a repaso</a>
                </div>
              `
              : `
                <div class="row" style="margin-top:10px">
                  <button class="btn" id="readQ" ${ttsSupported && !showKO ? "" : "disabled"} title="Lee la pregunta">🔊 Leer</button>
                  <button class="btn" id="voiceBtn" ${voiceSupported && !showKO ? "" : "disabled"} title="Responder por voz">🎙️ Voz</button>
                  <div class="spacer"></div>
                  <span class="pill" title="Anti-aburrimiento: prioriza nuevas/vencidas y evita repetición reciente">SRS activo</span>
                </div>

                ${
                  showKO
                    ? `
                      <div style="margin-top:14px; padding:12px; border-radius:14px; border:1px solid rgba(255,90,122,.55); background: rgba(255,90,122,.10)">
                        <h3 style="margin:0 0 8px">❌ Incorrecto</h3>
                        <p style="margin:0 0 6px; color:var(--muted)">Tu respuesta:</p>
                        <div class="pill" style="margin-bottom:10px"><b>${escapeHtml(lastKO.given || "—")}</b></div>

                        <p style="margin:0 0 6px; color:var(--muted)">Respuesta correcta:</p>
                        <div class="pill"><b>${escapeHtml(lastKO.correctAnswer)}</b></div>

                        <div class="row" style="margin-top:12px">
                          <button class="btn primary" id="continue">Continuar</button>
                        </div>
                      </div>
                    `
                    : `
                      <p style="margin-top:12px; color:var(--muted)">Definición</p>
                      <h3>${escapeHtml(currentCard?.question || "Cargando...")}</h3>
                      ${currentCard?.hint ? `<p><span class="pill">Pista</span> ${escapeHtml(currentCard.hint)}</p>` : ``}

                      <div style="margin-top:12px">
                        <input class="input" id="ans" placeholder="Escribe la respuesta…" autocomplete="off" />
                      </div>

                      <div class="row" style="margin-top:12px">
                        <button class="btn good" id="ok">Responder</button>
                        <button class="btn" id="skip">Pasar</button>
                        <button class="btn bad" id="fail">Fallo</button>
                      </div>

                      <p style="margin-top:10px; color:var(--muted)">
                        Acepta mayúsculas/minúsculas, tildes, artículos y variantes razonables.
                        Para nombres largos también tolera coincidencias parciales.
                      </p>
                    `
                }
              `
          }
        </div>

        <div class="card">
          <h3>Triángulo</h3>
          <p>Círculos = letras. Centro = pregunta actual.</p>

          <div class="legend">
            <span class="pill"><span class="dot new"></span> Pendiente</span>
            <span class="pill"><span class="dot ok"></span> Acierto</span>
            <span class="pill"><span class="dot fail"></span> Fallo</span>
            <span class="pill"><span class="dot" style="background:var(--muted)"></span> Pasada</span>
          </div>

          <div class="roscoWrap">
            ${triangleSVG(states, currentLetter, byLetter, centerText)}
          </div>
        </div>
      </section>
    `;

    // Handlers
    root.querySelector("#restart")?.addEventListener("click", restartRound);

    root.querySelector("#readQ")?.addEventListener("click", () => {
      if (ended() || pausedByKO) return;
      speak(currentCard?.question || "");
    });

    root.querySelector("#voiceBtn")?.addEventListener("click", () => {
      toggleListening();
    });

    root.querySelector("#continue")?.addEventListener("click", () => {
      continueAfterKO();
    });

    if (!ended() && playable && !pausedByKO) {
      const input = root.querySelector("#ans");
      input?.focus();

      root.querySelector("#ok")?.addEventListener("click", () => actAnswer("ok"));
      root.querySelector("#fail")?.addEventListener("click", () => actAnswer("fail"));
      root.querySelector("#skip")?.addEventListener("click", () => actAnswer("skip"));

      input?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") actAnswer("ok");
      });
    }
  }
}

// ====== Banco por letra ======
function buildByLetter(allCards) {
  const byLetter = new Map();
  for (const L of LETTERS) byLetter.set(L, []);

  for (const c of allCards) {
    const raw = (c.answer || "").trim();
    const rawFirst = raw.toUpperCase()[0] || "";

    // Ojo: normalizeAnswer convierte Ñ en n si viene con NFD; así que detectamos Ñ por el original
    const norm = normalizeAnswer(raw);
    const first = (norm[0] || "").toUpperCase();
    const letter = rawFirst === "Ñ" ? "Ñ" : first;

    if (byLetter.has(letter)) byLetter.get(letter).push(c);
  }
  return byLetter;
}

function firstPlayableLetter(byLetter) {
  for (const L of LETTERS) if (byLetter.get(L)?.length) return L;
  return LETTERS[0];
}

function allDone(states, byLetter) {
  // Termina cuando todas las letras con pool están ok/fail (skip no cuenta como terminada)
  for (const [L, pool] of byLetter.entries()) {
    if (!pool?.length) continue;
    if (states[L] === "new" || states[L] === "skip") return false;
  }
  return true;
}

function summary(states) {
  const vals = Object.values(states);
  const ok = vals.filter((x) => x === "ok").length;
  const fail = vals.filter((x) => x === "fail").length;
  const skip = vals.filter((x) => x === "skip").length;
  return `${ok} aciertos · ${fail} fallos · ${skip} pasadas`;
}

// ====== Selección SRS anti-repetición ======
async function pickCardForLetter(deckId, byLetter, letter) {
  const pool = byLetter.get(letter) || [];
  if (!pool.length) return null;

  const scored = [];
  for (const c of pool) {
    const key = `${deckId}:${c.cardId}`;
    const prog = (await get("progress", key)) || defaultProgress(deckId, c.cardId);
    const s = scoreForGame(prog);
    scored.push({ c, s });
  }

  // Ruleta ponderada
  const total = scored.reduce((a, x) => a + x.s, 0);
  let r = Math.random() * total;
  for (const x of scored) {
    r -= x.s;
    if (r <= 0) return x.c;
  }
  return scored[0].c;
}

async function reviewCard(deckId, cardId, grade) {
  const key = `${deckId}:${cardId}`;
  const prog = (await get("progress", key)) || defaultProgress(deckId, cardId);
  const updated = applyReview(prog, grade);
  await put("progress", updated);
}

// ====== Comparación de respuestas (tildes, mayúsculas, variantes, fuzzy) ======
function compareAnswers(givenRaw, correctRaw) {
  const given = prepForCompare(givenRaw);
  const correct = prepForCompare(correctRaw);

  if (!given) return { ok: false, reason: "empty" };

  // Exacta normalizada
  if (given === correct) return { ok: true, reason: "exact" };

  // Variantes: quitar artículos / preposiciones frecuentes
  const gv = stripStopwords(given);
  const cv = stripStopwords(correct);
  if (gv && gv === cv) return { ok: true, reason: "stopwords" };

  // Fuzzy por similitud (Levenshtein ratio)
  const sim = similarity(gv || given, cv || correct);
  if (sim >= FUZZY_THRESHOLD) return { ok: true, reason: "fuzzy", sim };

  // Nombres largos: permitir “contiene” por tokens (ej. "cervantes" vs "miguel de cervantes")
  if (ALLOW_CONTAINS_FOR_NAMES) {
    const okTokens = tokenContainment(gv || given, cv || correct);
    if (okTokens) return { ok: true, reason: "tokens" };
  }

  return { ok: false, reason: "no_match", sim };
}

function prepForCompare(s) {
  // normalizeAnswer ya hace: lower, trim, quita tildes, limpia signos, colapsa espacios
  // Extra: quita dobles espacios y normaliza guiones
  return normalizeAnswer(s).replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function stripStopwords(s) {
  if (!s) return "";
  const stop = new Set([
    "el",
    "la",
    "los",
    "las",
    "un",
    "una",
    "unos",
    "unas",
    "de",
    "del",
    "al",
    "y",
    "e",
    "a",
    "en",
    "por",
    "para",
    "con",
    "sin",
    "da",
    "do",
    "di"
  ]);
  const parts = s.split(" ").filter((w) => w && !stop.has(w));
  return parts.join(" ").trim();
}

function tokenContainment(given, correct) {
  // Si el usuario mete una parte “clave” del nombre, lo damos por válido:
  // - necesita al menos 1 token largo (>=5) que esté en la respuesta correcta
  // - o 2 tokens medios (>=4)
  const g = (given || "").split(" ").filter(Boolean);
  const c = ` ${correct || ""} `;

  let longHits = 0;
  let midHits = 0;
  for (const t of g) {
    if (t.length >= 5 && c.includes(` ${t} `)) longHits += 1;
    else if (t.length >= 4 && c.includes(` ${t} `)) midHits += 1;
  }
  return longHits >= 1 || midHits >= 2;
}

// Levenshtein ratio (0..1)
function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cb = b.charCodeAt(j - 1);
      const cost = ca === cb ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

// ====== UI: Triángulo de letras (círculos) + centro (rectángulo con pregunta) ======
function triangleSVG(states, currentLetter, byLetter, centerText) {
  const letters = LETTERS; // 27

  // Distribución: base 11 + lado izq 8 + lado der 8 = 27
  const baseCount = 11;
  const sideCount = 8;

  const base = letters.slice(0, baseCount);
  const left = letters.slice(baseCount, baseCount + sideCount);
  const right = letters.slice(baseCount + sideCount, baseCount + sideCount + sideCount);

  const W = 460;
  const H = 330;
  const pad = 28;

  const A = { x: W / 2, y: pad };        // vértice arriba
  const B = { x: pad, y: H - pad };      // base izq
  const C = { x: W - pad, y: H - pad };  // base der

  const r = 15;

  const canPlay = (L) => byLetter.get(L)?.length;

  const fillFor = (L) => {
    if (!canPlay(L)) return "rgba(168,178,209,.16)";
    if (L === currentLetter) return "rgba(91,124,250,.62)";
    const st = states[L];
    if (st === "ok") return "rgba(53,208,127,.58)";
    if (st === "fail") return "rgba(255,90,122,.58)";
    if (st === "skip") return "rgba(168,178,209,.35)";
    return "rgba(255,204,102,.45)";
  };

  // Puntos de los lados (sin incluir vértices duplicados)
  const ptsBase = distribute(B, C, base.length);
  const ptsLeft = distribute(B, A, left.length);
  const ptsRight = distribute(A, C, right.length);

  // Centro: rectángulo pregunta
  const cx = W / 2;
  const cy = H / 2 + 18;
  const rectW = 300;
  const rectH = 78;

  const safeCenter = clipText(String(centerText || "—"), 110);

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Triángulo de letras">`;

  // Rectángulo central
  svg += `
    <g>
      <rect x="${cx - rectW / 2}" y="${cy - rectH / 2}" width="${rectW}" height="${rectH}" rx="14"
        fill="rgba(15,22,38,.92)" stroke="rgba(37,49,79,.92)" />
      <text x="${cx}" y="${cy - 10}" text-anchor="middle" fill="rgba(233,238,252,.92)" font-size="12" font-weight="700">
        PREGUNTA
      </text>
      <foreignObject x="${cx - rectW / 2 + 12}" y="${cy - rectH / 2 + 26}" width="${rectW - 24}" height="${rectH - 34}">
        <div xmlns="http://www.w3.org/1999/xhtml"
             style="color: rgba(233,238,252,.92); font-size: 12px; line-height: 1.25; font-weight: 650; text-align:center; word-wrap:break-word;">
          ${escapeHtml(safeCenter)}
        </div>
      </foreignObject>
    </g>
  `;

  // Círculos: base
  base.forEach((L, i) => {
    const p = ptsBase[i];
    svg += circleNode(p.x, p.y, r, L, fillFor(L), canPlay(L), L === currentLetter);
  });

  // Círculos: lado izquierdo
  left.forEach((L, i) => {
    const p = ptsLeft[i];
    svg += circleNode(p.x, p.y, r, L, fillFor(L), canPlay(L), L === currentLetter);
  });

  // Círculos: lado derecho
  right.forEach((L, i) => {
    const p = ptsRight[i];
    svg += circleNode(p.x, p.y, r, L, fillFor(L), canPlay(L), L === currentLetter);
  });

  svg += `</svg>`;
  return svg;
}

function circleNode(x, y, r, label, fill, enabled, isCurrent) {
  const stroke = isCurrent ? "rgba(91,124,250,.95)" : "rgba(37,49,79,.88)";
  const opacity = enabled ? 1 : 0.55;
  return `
    <g opacity="${opacity}">
      <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" />
      <text x="${x}" y="${y + 4}" text-anchor="middle"
        fill="rgba(233,238,252,.95)" font-size="12" font-weight="900">${label}</text>
    </g>
  `;
}

function distribute(P, Q, n) {
  // n puntos equiespaciados entre P y Q (incluye extremos)
  if (n <= 1) return [P];
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({
      x: P.x + (Q.x - P.x) * t,
      y: P.y + (Q.y - P.y) * t
    });
  }
  return pts;
}

function clipText(s, maxLen) {
  if (!s) return "";
  const t = String(s).trim();
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen - 1) + "…";
}

// ====== Sonidos OK/KO (sin assets) ======
function beepOK() {
  beep(880, 0.08, 0.06);
  setTimeout(() => beep(1320, 0.07, 0.05), 90);
}

function beepKO() {
  beep(220, 0.12, 0.09);
  setTimeout(() => beep(180, 0.16, 0.10), 130);
}

function beep(freq, durationSec, gain) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = "sine";
    o.frequency.value = freq;
    g.gain.value = gain;

    o.connect(g);
    g.connect(ctx.destination);

    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close?.();
    }, Math.max(30, durationSec * 1000));
  } catch {
    // ignore
  }
}

// ====== Utils ======
function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
