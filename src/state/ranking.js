const LS_NICK = "ec_nick";

export function getNick() {
  try { return (localStorage.getItem(LS_NICK) || "").trim(); }
  catch { return ""; }
}

export function setNick(v) {
  try { localStorage.setItem(LS_NICK, (v || "").trim().slice(0, 18)); }
  catch {}
}

export async function submitScoreFromGameEnd(gameEndPayload, apiBase) {
  if (!apiBase) return false;

  const nick = getNick() || "Anónimo";
  const mode = gameEndPayload?.mode || "delta";

  const ok = Number(gameEndPayload?.ok ?? 0);
  const fail = Number(gameEndPayload?.fail ?? 0);
  const skip = Number(gameEndPayload?.skip ?? 0);
  const bestStreak = Number(gameEndPayload?.bestStreak ?? 0);
  const delta = Number(gameEndPayload?.delta ?? 0);

  // Fórmula de score simple, “picante” y consistente
  // (Aciertos pesan, racha pesa, fallos castigan, skips castigan, delta alto premia)
  const score =
    ok * 120 +
    bestStreak * 45 +
    Math.round(delta * 200) -
    fail * 80 -
    skip * 25;

  const payload = {
    nick,
    mode,
    score,
    stats: { ok, fail, skip, bestStreak, delta },
    ts: Date.now(),
    // Anti-trampa mínima: huella local (no es seguridad real, pero frena “copiar/pegar”)
    clientId: getClientId()
  };

  return await postJson(`${apiBase}/api/score`, payload);
}

export async function fetchTopScores(apiBase, { mode = "delta", limit = 50 } = {}) {
  if (!apiBase) return [];
  try {
    const res = await fetch(`${apiBase}/api/top?mode=${encodeURIComponent(mode)}&limit=${encodeURIComponent(String(limit))}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

function getClientId() {
  try {
    const k = "ec_client_id";
    let v = localStorage.getItem(k);
    if (v) return v;
    v = crypto?.randomUUID?.() || String(Math.random()).slice(2);
    localStorage.setItem(k, v);
    return v;
  } catch {
    return "na";
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
