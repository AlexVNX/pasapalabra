import { officialDeckId, listCards } from "../state/deck.js";
import { get, put } from "../state/db.js";
import { defaultProgress, applyReview, scoreForGame } from "../engine/srs.js";
import { normalizeAnswer } from "../engine/normalize.js";

const LETTERS = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ".split("");

// ====== Config ======
const DEFAULT_TIME_SEC = 120;
const FUZZY_THRESHOLD = 0.86; // 0..1
const ALLOW_CONTAINS_FOR_NAMES = true;

// Queremos 27 puntos EXACTOS alrededor del perímetro de un triángulo:
// right + (base-1) + (left-2) = 27
const RIGHT_EDGE_COUNT = 9; // incluye A (arriba) y C (abajo-dcha)
const BASE_COUNT = 11;      // incluye C y B -> aporta 10 al quitar C
const LEFT_EDGE_COUNT = 10; // incluye B y A -> aporta 8 al quitar B y A

export async function renderPasapalabra(root) {
  const deckId = officialDeckId();
  const all = await listCards(deckId);

  const byLetter = buildByLetter(all);

  let timeLeft = DEFAULT_TIME_SEC;
  let timer = null;

  const states = Object.fromEntries(LETTERS.map((L) => [L, "new"]));

  // Letra inicial: A si hay tarjetas, si no, primera jugable
  let currentLetter = byLetter.get("A")?.length ? "A" : firstPlayableLetter(byLetter);
  let currentCard = await pickCardForLetter(deckId, byLetter, currentLetter);

  let pausedByKO = false;
  let lastKO = null;

  const voiceSupported = isSpeechRecognitionSupported();
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  let recognition = null;
  let isListening = false;

  let muted = loadMuted();
  let lastSpokenCardId = null;

  startTimer();
  render();

  window.addEventListener(
    "hashchange",
    () => {
      stopTimer();
      stopListening();
      stopSpeaking();
    },
    { once: true }
  );

  // ===== Timer =====
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
        stopSpeaking();
        render();
      }
    }, 1000);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // ===== Voice =====
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
      if (txt) actAnswer("ok"); // auto-responder
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
      const btn = root.querySelector("#voiceBtn");
      if (btn) btn.textContent = "🎙️ Voz";
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

  // ===== TTS auto =====
  function speak(text) {
    if (!ttsSupported) return;
    if (muted) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "es-ES";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      // ignore
    }
  }

  function stopSpeaking() {
    if (!ttsSupported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }

  function toggleMute() {
    muted = !muted;
    saveMuted(muted);
    if (muted) stopSpeaking();
    render();
  }

  // ===== Game flow =====
  function ended() {
    return timeLeft === 0 || allDone(states, byLetter);
  }

  function nextLetterClockwise() {
    const order = clockwiseLetterOrder(); // A arriba, luego horario
    const idx = order.indexOf(currentLetter);

    for (let step = 1; step <= order.length; step++) {
      const L = order[(idx + step) % order.length];
      if (byLetter.get(L)?.length) {
        currentLetter = L;
        return;
      }
    }
  }

  async function goNext() {
    nextLetterClockwise();
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
      await goNext();
      return;
    }

    if (type === "fail") {
      states[currentLetter] = "fail";
      if (currentCard) await reviewCard(deckId, currentCard.cardId, 0);
      beepKO();
      pausedByKO = true;
      lastKO = { correctAnswer: currentCard?.answer ?? "", given: "", letter: currentLetter };
      stopListening();
      stopSpeaking();
      render();
      return;
    }

    const correct = currentCard?.answer ?? "";
    const res = compareAnswers(givenRaw, correct);

    if (res.ok) {
      states[currentLetter] = "ok";
      if (currentCard) await reviewCard(deckId, currentCard.cardId, 2);
      beepOK();
      stopListening();
      await goNext();
      return;
    }

    states[currentLetter] = "fail";
    if (currentCard) await reviewCard(deckId, currentCard.cardId, 0);
    beepKO();
    pausedByKO = true;
    lastKO = { correctAnswer: correct, given: givenRaw, letter: currentLetter };
    stopListening();
    stopSpeaking();
    render();
  }

  async function continueAfterKO() {
    pausedByKO = false;
    lastKO = null;
    const input = root.querySelector("#ans");
    if (input) input.value = "";
    await goNext();
  }

  function restartRound() {
    stopTimer();
    stopListening();
    stopSpeaking();

    timeLeft = DEFAULT_TIME_SEC;
    pausedByKO = false;
    lastKO = null;
    lastSpokenCardId = null;

    for (const L of LETTERS) states[L] = "new";
    currentLetter = byLetter.get("A")?.length ? "A" : firstPlayableLetter(byLetter);

    pickCardForLetter(deckId, byLetter, currentLetter).then((c) => {
      currentCard = c;
      startTimer();
      render();
    });
  }

  // ===== Render =====
  function render() {
    const playable = byLetter.get(currentLetter)?.length > 0;
    const showKO = pausedByKO && lastKO;
    const centerText = currentCard?.question || "—";

    root.innerHTML = `
      <section class="grid cols2">
        <div class="card">
          <div class="row">
            <h2 style="margin:0">Triángulo de letras</h2>
            <div class="spacer"></div>
            <span class="pill">Tiempo: <b id="t">${fmt(timeLeft)}</b></span>
          </div>

          <div class="row" style="margin-top:10px">
            <span class="pill">Letra: <b>${escapeHtml(currentLetter)}</b></span>
            <div class="spacer"></div>
            <button class="btn" id="muteBtn" title="Activar/desactivar voz">${muted ? "🔇 Muted" : "🔊 Voz"}</button>
            <button class="btn" id="voiceBtn" ${voiceSupported && !showKO ? "" : "disabled"} title="Responder por voz">🎙️ Voz</button>
          </div>

          ${
            !playable
              ? `<p style="margin-top:12px">No hay tarjetas para esta letra. Añade en el fichero oficial o en el editor.</p>`
              : ended()
              ? `
                <h3 style="margin-top:14px">Fin de ronda</h3>
                <p>Resumen: ${summary(states)}</p>
                <div class="row">
                  <button class="btn primary" id="restart">Jugar otra ronda</button>
                  <a class="btn" href="#/study">Ir a repaso</a>
                </div>
              `
              : showKO
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
                <div style="margin-top:12px">
                  <h3 style="margin:0 0 8px">${escapeHtml(currentCard?.question || "Cargando...")}</h3>
                  ${currentCard?.hint ? `<p><span class="pill">Pista</span> ${escapeHtml(currentCard.hint)}</p>` : ``}
                </div>

                <div style="margin-top:12px">
                  <input class="input" id="ans" placeholder="Escribe la respuesta…" autocomplete="off" />
                </div>

                <div class="row" style="margin-top:12px">
                  <button class="btn good" id="ok">Responder</button>
                  <button class="btn" id="skip">Pasar</button>
                  <button class="btn bad" id="fail">Fallo</button>
                </div>

                <p style="margin-top:10px; color:var(--muted)">
                  Acepta mayúsculas/minúsculas, tildes, signos, artículos, variantes y fuzzy. En nombres largos, acepta coincidencias parciales.
                </p>
              `
          }
        </div>

        <div class="card">
          <h3>Triángulo</h3>
          <p style="margin-bottom:10px">A arriba y recorrido horario (como un reloj). Centro = pregunta.</p>

          <div class="roscoWrap" style="padding:10px">
            ${triangleSVG(states, currentLetter, byLetter, centerText)}
          </div>
        </div>
      </section>
    `;

    root.querySelector("#restart")?.addEventListener("click", restartRound);
    root.querySelector("#continue")?.addEventListener("click", continueAfterKO);

    root.querySelector("#muteBtn")?.addEventListener("click", toggleMute);
    root.querySelector("#voiceBtn")?.addEventListener("click", toggleListening);

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

    // Auto-lectura (sin botón) + mute
    if (!ended() && playable && !pausedByKO && ttsSupported && !muted) {
      const cid = currentCard?.cardId || null;
      if (cid && cid !== lastSpokenCardId) {
        lastSpokenCardId = cid;
        setTimeout(() => speak(currentCard?.question || ""), 80);
      }
    }
  }
}

// ===== Banco por letra =====
function buildByLetter(allCards) {
  const byLetter = new Map();
  for (const L of LETTERS) byLetter.set(L, []);

  for (const c of allCards) {
    const raw = (c.answer || "").trim();
    const rawFirst = raw.toUpperCase()[0] || "";

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

// ===== Selección SRS =====
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

// ===== Comparación =====
function compareAnswers(givenRaw, correctRaw) {
  const given = prepForCompare(givenRaw);
  const correct = prepForCompare(correctRaw);

  if (!given) return { ok: false, reason: "empty" };
  if (given === correct) return { ok: true, reason: "exact" };

  const gv = stripStopwords(given);
  const cv = stripStopwords(correct);
  if (gv && gv === cv) return { ok: true, reason: "stopwords" };

  const sim = similarity(gv || given, cv || correct);
  if (sim >= FUZZY_THRESHOLD) return { ok: true, reason: "fuzzy", sim };

  if (ALLOW_CONTAINS_FOR_NAMES) {
    const okTokens = tokenContainment(gv || given, cv || correct);
    if (okTokens) return { ok: true, reason: "tokens" };
  }

  return { ok: false, reason: "no_match", sim };
}

function prepForCompare(s) {
  return normalizeAnswer(s).replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function stripStopwords(s) {
  if (!s) return "";
  const stop = new Set([
    "el","la","los","las","un","una","unos","unas","de","del","al","y","e","a","en","por","para","con","sin"
  ]);
  const parts = s.split(" ").filter((w) => w && !stop.has(w));
  return parts.join(" ").trim();
}

function tokenContainment(given, correct) {
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

// ===== ORDEN letras en perímetro (A arriba, horario) =====
function clockwiseLetterOrder() {
  // A fija arriba. El resto en orden alfabético después.
  return ["A", ...LETTERS.filter((x) => x !== "A")];
}

// ===== SVG Triángulo =====
function triangleSVG(states, currentLetter, byLetter, centerText) {
  const order = clockwiseLetterOrder(); // 27

  // Más grande + “triángulo obvio”
  const W = 640;
  const H = 460;
  const pad = 64; // separa letras del centro

  const top = { x: W / 2, y: pad };
  const left = { x: pad, y: H - pad };
  const right = { x: W - pad, y: H - pad };

  // Puntos en el perímetro
  const ptsRight = distribute(top, right, RIGHT_EDGE_COUNT); // incluye top y right
  const ptsBase = distribute(right, left, BASE_COUNT);       // incluye right y left
  const ptsLeft = distribute(left, top, LEFT_EDGE_COUNT);    // incluye left y top

  const perimeter = [
    ...ptsRight,            // top -> right
    ...ptsBase.slice(1),    // sin right: right -> left
    ...ptsLeft.slice(1, -1) // sin left y sin top: left -> top
  ];

  // Nunca inválido
  while (perimeter.length < order.length) perimeter.push(perimeter[perimeter.length - 1]);
  const points = perimeter.slice(0, order.length);

  const canPlay = (L) => byLetter.get(L)?.length;

  const fillFor = (L) => {
    if (!canPlay(L)) return "rgba(180,190,220,.14)";
    if (L === currentLetter) return "rgba(91,124,250,.85)";
    const st = states[L];
    if (st === "ok") return "rgba(53,208,127,.72)";
    if (st === "fail") return "rgba(255,90,122,.72)";
    if (st === "skip") return "rgba(180,190,220,.35)";
    return "rgba(255,204,102,.60)";
  };

  // Centro (sin solape): rect más pequeño + algo más arriba
  const cx = W / 2;
  const cy = H * 0.56;
  const rectW = 380;
  const rectH = 86;

  const lines = wrapLines(String(centerText || "—"), 34, 3);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Triángulo de letras">`;

  // Contorno del triángulo (para que SE VEA triangular sí o sí)
  svg += `
    <path d="M ${top.x} ${top.y} L ${right.x} ${right.y} L ${left.x} ${left.y} Z"
      fill="none" stroke="rgba(120,140,190,.22)" stroke-width="2" />
  `;

  // Centro
  svg += `
    <g>
      <rect x="${cx - rectW / 2}" y="${cy - rectH / 2}" width="${rectW}" height="${rectH}" rx="16"
        fill="rgba(10,14,24,.92)" stroke="rgba(120,140,190,.28)" />
      <text x="${cx}" y="${cy - 14}" text-anchor="middle"
        fill="rgba(233,238,252,.92)" font-size="13" font-weight="800">${escapeXml(lines[0] || "")}</text>
      ${lines[1] ? `<text x="${cx}" y="${cy + 6}" text-anchor="middle"
        fill="rgba(233,238,252,.92)" font-size="13" font-weight="800">${escapeXml(lines[1])}</text>` : ``}
      ${lines[2] ? `<text x="${cx}" y="${cy + 26}" text-anchor="middle"
        fill="rgba(233,238,252,.92)" font-size="13" font-weight="800">${escapeXml(lines[2])}</text>` : ``}
    </g>
  `;

  // Letras
  const r = 18;
  for (let i = 0; i < order.length; i++) {
    const L = order[i];
    const p = points[i];
    svg += circleNode(p.x, p.y, r, L, fillFor(L), !!canPlay(L), L === currentLetter);
  }

  svg += `</svg>`;
  return svg;
}

function circleNode(x, y, r, label, fill, enabled, isCurrent) {
  const stroke = isCurrent ? "rgba(255,255,255,.95)" : "rgba(120,140,190,.38)";
  const opacity = enabled ? 1 : 0.45;
  const txtFill = enabled ? "rgba(233,238,252,.95)" : "rgba(233,238,252,.55)";
  return `
    <g opacity="${opacity}">
      <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${isCurrent ? 2.6 : 1.6}" />
      <text x="${x}" y="${y + 5}" text-anchor="middle"
        fill="${txtFill}" font-size="13" font-weight="900">${label}</text>
    </g>
  `;
}

function distribute(P, Q, n) {
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

// Wrap simple por longitud (suficiente)
function wrapLines(text, maxCharsPerLine, maxLines) {
  const clean = String(text || "").trim().replace(/\s+/g, " ");
  if (!clean) return ["—", "", ""];
  const words = clean.split(" ");
  const lines = [];
  let line = "";

  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxCharsPerLine) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = w;
      if (lines.length >= maxLines - 1) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);

  const usedWords = lines.join(" ").split(" ").filter(Boolean).length;
  if (usedWords < words.length && lines.length) {
    lines[lines.length - 1] = lines[lines.length - 1].replace(/…?$/, "") + "…";
  }

  while (lines.length < maxLines) lines.push("");
  return lines.slice(0, maxLines);
}

// ===== Sonidos =====
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

// ===== Persistencia mute =====
function loadMuted() {
  try {
    return localStorage.getItem("ec_muted") === "1";
  } catch {
    return false;
  }
}
function saveMuted(v) {
  try {
    localStorage.setItem("ec_muted", v ? "1" : "0");
  } catch {
    // ignore
  }
}

// ===== Utils =====
function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function escapeXml(s) {
  return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
}
