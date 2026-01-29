import { officialDeckId, listCards } from "../state/deck.js";
import { get, put } from "../state/db.js";
import { defaultProgress, applyReview, scoreForGame } from "../engine/srs.js";
import { normalizeAnswer } from "../engine/normalize.js";

const LETTERS = "ABCDEFGHIJKLMNÑOPQRSTUVWXYZ".split("");

const DEFAULT_TIME_SEC = 120;

// Base matching (se volverá más estricto con la dificultad)
const BASE_FUZZY_THRESHOLD = 0.86;
const MIN_FUZZY_THRESHOLD = 0.80;
const MAX_FUZZY_THRESHOLD = 0.93;

const ALLOW_CONTAINS_FOR_NAMES = true;

// Perímetro exacto (27 puntos)
const RIGHT_EDGE_COUNT = 9;
const BASE_COUNT = 11;
const LEFT_EDGE_COUNT = 10;

// Δ Dificultad (shot clock por pregunta)
const SHOT_BASE_SEC = 12;
const SHOT_MIN_SEC = 5;
const SHOT_MAX_SEC = 16;
const DELTA_UP_ON_GOOD = 0.08;
const DELTA_DOWN_ON_BAD = 0.10;
const DELTA_DOWN_ON_SKIP = 0.03;

// Persist keys
const LS_TTS_MUTED = "ec_muted_tts";
const LS_SFX_MUTED = "ec_muted_sfx";
const LS_VOICE_CONT = "ec_voice_cont";

export async function renderPasapalabra(root) {
  const deckId = officialDeckId();
  const all = await listCards(deckId);

  const byLetter = buildByLetter(all);

  let timeLeft = DEFAULT_TIME_SEC;
  let timer = null;

  // Shot clock por pregunta
  let shotLeft = SHOT_BASE_SEC;
  let shotTimer = null;
  let currentQuestionStartedAt = 0;

  // Δ dificultad 0..1
  let delta = 0.0;

  // racha y stats
  let streak = 0;
  let bestStreak = 0;
  let answeredCount = 0;

  const states = Object.fromEntries(LETTERS.map((L) => [L, "new"]));

  let pausedByKO = false;
  let lastKO = null;

  const voiceSupported = isSpeechRecognitionSupported();
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  let recognition = null;
  let isListening = false;

  // Ajustes
  let ttsMuted = loadBool(LS_TTS_MUTED, false);
  let sfxMuted = loadBool(LS_SFX_MUTED, false);
  let voiceContinuous = loadBool(LS_VOICE_CONT, true);

  let lastSpokenCardId = null;

  // SFX engine (WebAudio)
  const sfx = createSfxEngine(() => sfxMuted);

  // Selección inicial: primera letra PENDIENTE (new/skip) que tenga pool
  let currentLetter = firstPendingPlayableLetter(byLetter, states);
  let currentCard = currentLetter ? await pickCardForLetter(deckId, byLetter, currentLetter) : null;

  emitEvent("game_start", { mode: "delta" });

  startTimer();
  if (currentLetter) startShotClock();
  render();

  window.addEventListener(
    "hashchange",
    () => {
      stopTimer();
      stopShotClock();
      stopListening();
      stopSpeaking();
    },
    { once: true }
  );

  /* =========================
     Timers
  ========================= */

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
        stopShotClock();
        emitEvent("game_end", buildEndPayload());
        sfx.end();
        render();
      }
    }, 1000);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function isPendingLetter(L) {
    return states[L] === "new" || states[L] === "skip";
  }

  function computeShotLimitSec() {
    const d = clamp(delta, 0, 1);
    const fromDelta = SHOT_BASE_SEC - d * (SHOT_BASE_SEC - SHOT_MIN_SEC);
    const fromStreak = Math.max(0, (streak - 6) * 0.35);
    const raw = fromDelta - fromStreak;
    return clamp(raw, SHOT_MIN_SEC, SHOT_MAX_SEC);
  }

  function startShotClock() {
    stopShotClock();
    currentQuestionStartedAt = Date.now();
    shotLeft = Math.round(computeShotLimitSec());

    const shotEl = root.querySelector("#shot");
    if (shotEl) shotEl.textContent = String(shotLeft);

    shotTimer = setInterval(() => {
      if (pausedByKO) return;
      if (timeLeft <= 0) return;
      if (ended()) return;

      shotLeft -= 1;
      if (shotLeft < 0) shotLeft = 0;

      const el = root.querySelector("#shot");
      if (el) el.textContent = String(shotLeft);

      if (shotLeft === 0) actAnswer("timeout");
    }, 1000);
  }

  function stopShotClock() {
    if (shotTimer) clearInterval(shotTimer);
    shotTimer = null;
  }

  /* =========================
     Voice (SpeechRecognition)
  ========================= */

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

    try {
      rec.continuous = !!voiceContinuous;
    } catch {
      // ignore
    }

    rec.onresult = (e) => {
      if (pausedByKO) return;
      if (timeLeft === 0) return;
      if (ended()) return;

      const txt =
        e.results?.[0]?.[0]?.transcript?.trim?.() ??
        e.results?.[0]?.transcript?.trim?.() ??
        "";

      if (!txt) return;

      const cmd = normalizeVoiceCommand(txt);
      if (cmd === "skip") return actAnswer("skip");
      if (cmd === "fail") return actAnswer("fail");

      const input = root.querySelector("#ans");
      if (input) input.value = txt;
      actAnswer("ok");
    };

    rec.onend = () => {
      isListening = false;
      updateVoiceBtn();

      if (voiceContinuous && !pausedByKO && timeLeft > 0 && !ended()) {
        setTimeout(() => {
          if (voiceContinuous && !isListening && !pausedByKO && timeLeft > 0 && !ended()) {
            try {
              isListening = true;
              updateVoiceBtn();
              rec.start();
            } catch {
              isListening = false;
              updateVoiceBtn();
            }
          }
        }, 180);
      }
    };

    rec.onerror = () => {
      isListening = false;
      updateVoiceBtn();
    };

    return rec;
  }

  function updateVoiceBtn() {
    const btn = root.querySelector("#voiceBtn");
    if (!btn) return;

    if (!voiceSupported) {
      btn.textContent = "🎙️ Voz";
      btn.disabled = true;
      return;
    }
    if (pausedByKO || timeLeft === 0 || ended()) {
      btn.textContent = "🎙️ Voz";
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    btn.textContent = isListening ? "🛑 Parar" : (voiceContinuous ? "🎙️ Voz ∞" : "🎙️ Voz");
  }

  function toggleListening() {
    if (!voiceSupported) return;
    if (timeLeft === 0) return;
    if (pausedByKO) return;
    if (ended()) return;

    if (!recognition) recognition = initRecognition();
    if (!recognition) return;

    if (isListening) return stopListening();

    try {
      isListening = true;
      updateVoiceBtn();
      recognition.start();
      sfx.unlock();
    } catch {
      isListening = false;
      updateVoiceBtn();
    }
  }

  function stopListening() {
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {}
    isListening = false;
    updateVoiceBtn();
  }

  function toggleVoiceContinuous() {
    voiceContinuous = !voiceContinuous;
    saveBool(LS_VOICE_CONT, voiceContinuous);

    if (recognition) {
      try { recognition.onend = null; recognition.onerror = null; recognition.onresult = null; } catch {}
      try { recognition.stop(); } catch {}
      recognition = null;
      isListening = false;
    }

    render();
  }

  function normalizeVoiceCommand(txt) {
    const s = normalizeAnswer(txt).trim();
    if (s === "pasapalabra" || s === "paso" || s === "pasar" || s === "siguiente") return "skip";
    if (s === "fallo" || s === "me rindo" || s === "incorrecta" || s === "no se") return "fail";
    return "";
  }

  /* =========================
     TTS
  ========================= */

  function speak(text) {
    if (!ttsSupported) return;
    if (ttsMuted) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "es-ES";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {}
  }

  function stopSpeaking() {
    if (!ttsSupported) return;
    try { window.speechSynthesis.cancel(); } catch {}
  }

  function toggleTtsMute() {
    ttsMuted = !ttsMuted;
    saveBool(LS_TTS_MUTED, ttsMuted);
    if (ttsMuted) stopSpeaking();
    render();
  }

  function toggleSfxMute() {
    sfxMuted = !sfxMuted;
    saveBool(LS_SFX_MUTED, sfxMuted);
    render();
  }

  /* =========================
     Flow
  ========================= */

  function ended() {
    if (timeLeft === 0) return true;
    // Termina si NO queda ninguna letra pendiente con pool
    for (const [L, pool] of byLetter.entries()) {
      if (!pool?.length) continue;
      if (isPendingLetter(L)) return false;
    }
    return true;
  }

  function nextPendingLetterClockwise() {
    const order = clockwiseLetterOrder();
    const idx = order.indexOf(currentLetter);

    for (let step = 1; step <= order.length; step++) {
      const L = order[(idx + step) % order.length];
      if (byLetter.get(L)?.length && isPendingLetter(L)) {
        currentLetter = L;
        return true;
      }
    }
    return false;
  }

  async function goNext() {
    // Buscar siguiente letra pendiente (new/skip)
    const ok = nextPendingLetterClockwise();
    if (!ok) {
      // Ya no hay pendientes: fin
      stopShotClock();
      stopListening();
      stopSpeaking();
      emitEvent("game_end", buildEndPayload());
      sfx.end();
      render();
      return;
    }

    currentCard = await pickCardForLetter(deckId, byLetter, currentLetter);
    startShotClock();
    render();
  }

  function getStrictFuzzyThreshold() {
    const d = clamp(delta, 0, 1);
    const t = BASE_FUZZY_THRESHOLD + d * (MAX_FUZZY_THRESHOLD - BASE_FUZZY_THRESHOLD);
    return clamp(t, MIN_FUZZY_THRESHOLD, MAX_FUZZY_THRESHOLD);
  }

  function updateDeltaOnOutcome(outcome, elapsedSec) {
    if (outcome === "ok") {
      const shotLimit = computeShotLimitSec();
      const speedBonus = clamp(1 - (elapsedSec / Math.max(1, shotLimit)), 0, 1) * 0.05;
      delta = clamp(delta + DELTA_UP_ON_GOOD + speedBonus, 0, 1);
      return;
    }
    if (outcome === "skip") {
      delta = clamp(delta - DELTA_DOWN_ON_SKIP, 0, 1);
      return;
    }
    delta = clamp(delta - DELTA_DOWN_ON_BAD, 0, 1);
  }

  async function actAnswer(type) {
    if (timeLeft === 0) return;
    if (ended()) return;
    if (pausedByKO) return;

    // Si por lo que sea caímos en una letra ya resuelta, saltamos
    if (!isPendingLetter(currentLetter)) {
      return goNext();
    }

    const input = root.querySelector("#ans");
    const givenRaw = input ? input.value : "";
    const elapsedSec = (Date.now() - currentQuestionStartedAt) / 1000;

    if (type === "timeout") {
      // fallo automático
      states[currentLetter] = "fail";
      streak = 0;
      if (currentCard) await reviewCard(deckId, currentCard.cardId, 0);

      sfx.ko();
      sfx.crowdOoooh();

      pausedByKO = true;
      lastKO = {
        correctAnswer: currentCard?.answer ?? "",
        given: "(tiempo agotado)",
        letter: currentLetter
      };

      updateDeltaOnOutcome("timeout", elapsedSec);
      emitEvent("answer_wrong", buildAnswerPayload({ reason: "timeout", given: "" }));

      stopListening();
      stopSpeaking();
      stopShotClock();
      render();
      return;
    }

    if (type === "skip") {
      states[currentLetter] = "skip"; // esta SÍ se repetirá
      streak = 0;
      updateDeltaOnOutcome("skip", elapsedSec);
      sfx.skip();
      emitEvent("pass", buildAnswerPayload({ reason: "skip", given: "" }));
      await goNext();
      return;
    }

    if (type === "fail") {
      states[currentLetter] = "fail"; // esta NO se repetirá
      streak = 0;
      if (currentCard) await reviewCard(deckId, currentCard.cardId, 0);

      sfx.ko();
      sfx.crowdOoooh();

      pausedByKO = true;
      lastKO = { correctAnswer: currentCard?.answer ?? "", given: "", letter: currentLetter };

      updateDeltaOnOutcome("fail", elapsedSec);
      emitEvent("answer_wrong", buildAnswerPayload({ reason: "manual_fail", given: "" }));

      stopListening();
      stopSpeaking();
      stopShotClock();
      render();
      return;
    }

    const correct = currentCard?.answer ?? "";
    const fuzzyThreshold = getStrictFuzzyThreshold();
    const res = compareAnswers(givenRaw, correct, fuzzyThreshold);

    answeredCount += 1;

    if (res.ok) {
      states[currentLetter] = "ok"; // NO se repite
      streak += 1;
      if (streak > bestStreak) bestStreak = streak;

      if (currentCard) await reviewCard(deckId, currentCard.cardId, 2);

      sfx.ok();
      updateDeltaOnOutcome("ok", elapsedSec);

      emitEvent("answer_correct", buildAnswerPayload({
        reason: res.reason,
        sim: res.sim ?? null,
        given: givenRaw
      }));

      stopSpeaking();
      if (!voiceContinuous) stopListening();

      await goNext();
      return;
    }

    // Incorrecta => fail (NO se repite)
    states[currentLetter] = "fail";
    streak = 0;
    if (currentCard) await reviewCard(deckId, currentCard.cardId, 0);

    sfx.ko();
    sfx.crowdOoooh();

    pausedByKO = true;
    lastKO = { correctAnswer: correct, given: givenRaw, letter: currentLetter };

    updateDeltaOnOutcome("fail", elapsedSec);
    emitEvent("answer_wrong", buildAnswerPayload({
      reason: res.reason || "no_match",
      sim: res.sim ?? null,
      given: givenRaw
    }));

    stopListening();
    stopSpeaking();
    stopShotClock();
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
    stopShotClock();
    stopListening();
    stopSpeaking();

    timeLeft = DEFAULT_TIME_SEC;
    pausedByKO = false;
    lastKO = null;
    lastSpokenCardId = null;

    delta = 0.0;
    streak = 0;
    bestStreak = 0;
    answeredCount = 0;

    for (const L of LETTERS) states[L] = "new";

    currentLetter = firstPendingPlayableLetter(byLetter, states);
    currentCard = null;

    emitEvent("game_start", { mode: "delta" });

    if (!currentLetter) {
      render();
      return;
    }

    pickCardForLetter(deckId, byLetter, currentLetter).then((c) => {
      currentCard = c;
      startTimer();
      startShotClock();
      render();
    });
  }

  /* =========================
     Render
  ========================= */

  function render() {
    const playable = currentLetter && byLetter.get(currentLetter)?.length > 0;
    const showKO = pausedByKO && lastKO;
    const centerText = currentCard?.question || "—";

    const fuzzyNow = getStrictFuzzyThreshold();
    const shotLimit = computeShotLimitSec();

    root.innerHTML = `
      <section class="grid cols2">
        <div class="card">
          <div class="row">
            <div>
              <h2 style="margin:0">DeltaQuiz</h2>
              <div style="margin-top:4px; color:var(--muted); font-weight:700; letter-spacing:.2px;">Modo Δ (casi imposible)</div>
            </div>
            <div class="spacer"></div>
            <span class="pill">Tiempo: <b id="t">${fmt(timeLeft)}</b></span>
          </div>

          <div class="row" style="margin-top:10px">
            <span class="pill">Letra: <b>${escapeHtml(currentLetter || "—")}</b></span>
            <span class="pill" title="Cuenta atrás por pregunta">Shot: <b id="shot">${String(shotLeft)}</b>s</span>
            <div class="spacer"></div>

            <button class="btn" id="ttsBtn" title="Activar/desactivar lectura de la pregunta">${ttsMuted ? "🔇 Voz" : "🔊 Voz"}</button>
            <button class="btn" id="sfxBtn" title="Activar/desactivar efectos de sonido">${sfxMuted ? "🔕 SFX" : "🔔 SFX"}</button>
            <button class="btn" id="voiceModeBtn" title="Voz: continuo o botón">${voiceContinuous ? "∞" : "1x"} Voz</button>
            <button class="btn" id="voiceBtn" ${voiceSupported && !showKO ? "" : "disabled"} title="${voiceSupported ? "Responder por voz" : "Voz no soportada"}">🎙️ Voz</button>
          </div>

          <div class="row" style="margin-top:10px">
            <span class="pill" title="Dificultad adaptativa">Δ: <b>${Math.round(delta * 100)}%</b></span>
            <span class="pill" title="Racha actual / mejor racha">Racha: <b>${streak}</b> / <b>${bestStreak}</b></span>
            <span class="pill" title="Tolerancia de corrección (más alto = más estricto)">Precisión: <b>${fuzzyNow.toFixed(2)}</b></span>
            <div class="spacer"></div>
            <span class="pill" title="Límite recomendado por pregunta">Límite: <b>${Math.round(shotLimit)}s</b></span>
          </div>

          ${
            !playable
              ? `<p style="margin-top:12px">No hay letras pendientes con preguntas (o no hay mazo cargado).</p>
                 <div class="row" style="margin-top:10px">
                   <button class="btn primary" id="restart">Reiniciar</button>
                 </div>`
              : ended()
              ? `
                <h3 style="margin-top:14px">Fin de ronda</h3>
                <p>Resumen: ${summary(states)}</p>
                <div class="row">
                  <button class="btn primary" id="restart">Jugar otra ronda</button>
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
                </div>

                <div style="margin-top:12px">
                  <input class="input" id="ans" placeholder="Escribe la respuesta…" autocomplete="off" />
                </div>

                <div class="row" style="margin-top:12px">
                  <button class="btn good" id="ok">Responder</button>
                  <button class="btn" id="skip">Pasar</button>
                  <button class="btn bad" id="fail">Fallo</button>
                </div>

                <p style="margin-top:10px; font-size:13px; color:var(--muted)">
                  Voz: di <b>“pasapalabra”</b> para pasar. (Las letras acertadas/falladas no vuelven.)
                </p>
              `
          }
        </div>

        <div class="card">
          <h3>Δ Panel Delta</h3>
          <div class="roscoWrap" style="padding:10px">
            ${triangleSVG(states, currentLetter || "A", byLetter, centerText)}
          </div>
        </div>
      </section>
    `;

    root.querySelector("#restart")?.addEventListener("click", restartRound);
    root.querySelector("#continue")?.addEventListener("click", continueAfterKO);

    root.querySelector("#ttsBtn")?.addEventListener("click", () => { sfx.unlock(); toggleTtsMute(); });
    root.querySelector("#sfxBtn")?.addEventListener("click", () => { sfx.unlock(); toggleSfxMute(); });

    root.querySelector("#voiceModeBtn")?.addEventListener("click", () => { sfx.unlock(); toggleVoiceContinuous(); });
    root.querySelector("#voiceBtn")?.addEventListener("click", toggleListening);

    updateVoiceBtn();

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

    // Auto-lectura (TTS)
    if (!ended() && playable && !pausedByKO && ttsSupported && !ttsMuted) {
      const cid = currentCard?.cardId || null;
      if (cid && cid !== lastSpokenCardId) {
        lastSpokenCardId = cid;
        setTimeout(() => speak(currentCard?.question || ""), 80);
      }
    }
  }

  /* =========================
     Analytics hooks
  ========================= */

  function emitEvent(name, payload = {}) {
    try {
      window.dispatchEvent(new CustomEvent("ec_event", { detail: { name, payload, ts: Date.now() } }));
    } catch {}
  }

  function buildAnswerPayload(extra = {}) {
    return {
      mode: "delta",
      letter: currentLetter,
      cardId: currentCard?.cardId ?? null,
      delta: Number(delta.toFixed(3)),
      streak,
      timeLeft,
      shotLeft,
      ...extra
    };
  }

  function buildEndPayload() {
    const vals = Object.values(states);
    const ok = vals.filter((x) => x === "ok").length;
    const fail = vals.filter((x) => x === "fail").length;
    const skip = vals.filter((x) => x === "skip").length;
    return {
      mode: "delta",
      ok, fail, skip,
      bestStreak,
      answeredCount,
      delta: Number(delta.toFixed(3))
    };
  }
}

/* =========================
   Data helpers
========================= */

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

function firstPendingPlayableLetter(byLetter, states) {
  for (const L of LETTERS) {
    if (!byLetter.get(L)?.length) continue;
    if (states[L] === "new" || states[L] === "skip") return L;
  }
  return null;
}

function summary(states) {
  const vals = Object.values(states);
  const ok = vals.filter((x) => x === "ok").length;
  const fail = vals.filter((x) => x === "fail").length;
  const skip = vals.filter((x) => x === "skip").length;
  return `${ok} aciertos · ${fail} fallos · ${skip} pasadas`;
}

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

/* =========================
   Answer matching
========================= */

function compareAnswers(givenRaw, correctRaw, fuzzyThreshold) {
  const given = prepForCompare(givenRaw);
  const correct = prepForCompare(correctRaw);

  if (!given) return { ok: false, reason: "empty" };
  if (given === correct) return { ok: true, reason: "exact" };

  const gv = stripStopwords(given);
  const cv = stripStopwords(correct);
  if (gv && gv === cv) return { ok: true, reason: "stopwords" };

  const sim = similarity(gv || given, cv || correct);
  if (sim >= fuzzyThreshold) return { ok: true, reason: "fuzzy", sim };

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
  const stop = new Set(["el","la","los","las","un","una","unos","unas","de","del","al","y","e","a","en","por","para","con","sin"]);
  return s.split(" ").filter((w) => w && !stop.has(w)).join(" ").trim();
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
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/* =========================
   Delta panel (SVG)
========================= */

function clockwiseLetterOrder() {
  return ["A", ...LETTERS.filter((x) => x !== "A")];
}

function triangleSVG(states, currentLetter, byLetter, centerText) {
  const order = clockwiseLetterOrder();

  const W = 640;
  const H = 460;
  const pad = 64;

  const top = { x: W / 2, y: pad };
  const left = { x: pad, y: H - pad };
  const right = { x: W - pad, y: H - pad };

  const ptsRight = distribute(top, right, RIGHT_EDGE_COUNT);
  const ptsBase = distribute(right, left, BASE_COUNT);
  const ptsLeft = distribute(left, top, LEFT_EDGE_COUNT);

  const perimeter = [...ptsRight, ...ptsBase.slice(1), ...ptsLeft.slice(1, -1)];
  while (perimeter.length < order.length) perimeter.push(perimeter[perimeter.length - 1]);
  const points = perimeter.slice(0, order.length);

  const canPlay = (L) => byLetter.get(L)?.length;

  const COLORS = {
    base: "#2F6BFF",
    skip: "#F6C343",
    ok: "#2ECC71",
    fail: "#FF4D6D",
    disabled: "#D8DEE9"
  };

  const fillFor = (L) => {
    if (!canPlay(L)) return COLORS.disabled;
    const st = states[L];
    if (st === "ok") return COLORS.ok;
    if (st === "fail") return COLORS.fail;
    if (st === "skip") return COLORS.skip;
    return COLORS.base;
  };

  const cx = W / 2;
  const cy = H * 0.56;
  const rectW = 390;
  const rectH = 88;

  const lines = wrapLines(String(centerText || "—"), 34, 3);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="auto" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Panel Delta">`;

  svg += `
    <g>
      <rect class="tri-center-rect" x="${cx - rectW / 2}" y="${cy - rectH / 2}" width="${rectW}" height="${rectH}" rx="16" />
      <text class="tri-center-text" x="${cx}" y="${cy - 14}" text-anchor="middle" font-size="14" font-weight="900">${escapeXml(lines[0] || "")}</text>
      ${lines[1] ? `<text class="tri-center-text" x="${cx}" y="${cy + 7}" text-anchor="middle" font-size="14" font-weight="900">${escapeXml(lines[1])}</text>` : ``}
      ${lines[2] ? `<text class="tri-center-text" x="${cx}" y="${cy + 28}" text-anchor="middle" font-size="14" font-weight="900">${escapeXml(lines[2])}</text>` : ``}
    </g>
  `;

  const r = 22;
  for (let i = 0; i < order.length; i++) {
    const L = order[i];
    const p = points[i];
    svg += circleNode(p.x, p.y, r, L, fillFor(L), !!canPlay(L), L === currentLetter);
  }

  svg += `</svg>`;
  return svg;
}

function circleNode(x, y, r, label, fill, enabled, isCurrent) {
  const stroke = isCurrent ? "#0b2a7a" : "rgba(15,23,42,0.18)";
  const strokeW = isCurrent ? 3.2 : 1.6;
  const txtFill = enabled ? "#FFFFFF" : "rgba(15,23,42,0.55)";
  const opacity = enabled ? 1 : 0.55;

  return `
    <g opacity="${opacity}">
      <circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" />
      <text class="tri-letter-text" x="${x}" y="${y + 7}" text-anchor="middle"
        fill="${txtFill}" font-size="16" font-weight="900">${label}</text>
    </g>
  `;
}

function distribute(P, Q, n) {
  if (n <= 1) return [P];
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    pts.push({ x: P.x + (Q.x - P.x) * t, y: P.y + (Q.y - P.y) * t });
  }
  return pts;
}

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
  if (usedWords < words.length && lines.length) lines[lines.length - 1] = lines[lines.length - 1] + "…";

  while (lines.length < maxLines) lines.push("");
  return lines.slice(0, maxLines);
}

/* =========================
   SFX (más fuertes + crowd real)
========================= */

function createSfxEngine(isMutedFn) {
  let ctx = null;
  let master = null;
  let compressor = null;

  function ensure() {
    if (isMutedFn()) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;

    if (!ctx) {
      ctx = new AC();

      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 24;
      compressor.ratio.value = 12;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.18;

      master = ctx.createGain();
      master.gain.value = 1.0;

      master.connect(compressor);
      compressor.connect(ctx.destination);
    }

    return ctx;
  }

  function unlock() {
    try {
      const c = ensure();
      if (!c) return;
      if (c.state === "suspended") c.resume?.();

      // ping “mudo” para desbloquear audio en móviles
      const o = c.createOscillator();
      const g = c.createGain();
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(master);
      o.start();
      o.stop(c.currentTime + 0.02);
    } catch {}
  }

  function tone(freq, dur, gain = 0.14, type = "sine") {
    try {
      const c = ensure();
      if (!c) return;
      if (c.state === "suspended") c.resume?.();

      const o = c.createOscillator();
      const g = c.createGain();

      o.type = type;
      o.frequency.setValueAtTime(freq, c.currentTime);

      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), c.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);

      o.connect(g);
      g.connect(master);

      o.start();
      o.stop(c.currentTime + dur + 0.02);
    } catch {}
  }

  function noise(dur = 0.28, gain = 0.08, hp = 180, lp = 1600) {
    try {
      const c = ensure();
      if (!c) return;
      if (c.state === "suspended") c.resume?.();

      const bufferSize = Math.max(1, Math.floor(c.sampleRate * dur));
      const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
      const data = buffer.getChannelData(0);

      // “brown-ish” noise: más grave, más crowd
      let last = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = (Math.random() * 2 - 1);
        last = (last + (0.02 * white)) / 1.02;
        data[i] = last * 3.5;
      }

      const src = c.createBufferSource();
      src.buffer = buffer;

      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, c.currentTime);
      g.gain.exponentialRampToValueAtTime(gain, c.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);

      const hpf = c.createBiquadFilter();
      hpf.type = "highpass";
      hpf.frequency.value = hp;

      const lpf = c.createBiquadFilter();
      lpf.type = "lowpass";
      lpf.frequency.value = lp;

      src.connect(hpf);
      hpf.connect(lpf);
      lpf.connect(g);
      g.connect(master);

      src.start();
      src.stop(c.currentTime + dur + 0.02);
    } catch {}
  }

  function oooohFormant() {
    // Un “ooooh” sintético: ruido + dos formantes barridos
    if (isMutedFn()) return;

    noise(0.32, 0.12, 120, 1200);

    tone(220, 0.34, 0.10, "sawtooth");
    setTimeout(() => tone(196, 0.34, 0.09, "sawtooth"), 60);

    // “wah” extra
    setTimeout(() => tone(165, 0.24, 0.07, "triangle"), 120);
  }

  function ok() {
    if (isMutedFn()) return;
    tone(920, 0.08, 0.14, "triangle");
    setTimeout(() => tone(1320, 0.07, 0.12, "triangle"), 80);
  }

  function ko() {
    if (isMutedFn()) return;
    tone(220, 0.14, 0.16, "sine");
    setTimeout(() => tone(165, 0.18, 0.14, "sine"), 110);
  }

  function skip() {
    if (isMutedFn()) return;
    tone(520, 0.06, 0.10, "square");
    setTimeout(() => tone(740, 0.05, 0.09, "square"), 55);
  }

  function end() {
    if (isMutedFn()) return;
    tone(660, 0.10, 0.10, "triangle");
    setTimeout(() => tone(880, 0.10, 0.10, "triangle"), 120);
    setTimeout(() => tone(1100, 0.14, 0.10, "triangle"), 260);
  }

  function crowdOoooh() {
    oooohFormant();
  }

  return { unlock, ok, ko, skip, end, crowdOoooh };
}

/* =========================
   Persistence helpers
========================= */

function loadBool(key, def = false) {
  try {
    const v = localStorage.getItem(key);
    if (v == null) return def;
    return v === "1";
  } catch {
    return def;
  }
}

function saveBool(key, v) {
  try { localStorage.setItem(key, v ? "1" : "0"); } catch {}
}

/* =========================
   Utils
========================= */

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function escapeXml(s) {
  return String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&lt;", '"': "&quot;" }[m]));
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
