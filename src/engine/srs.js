// SRS simple inspirado en SM-2 (suficiente para MVP)
export function defaultProgress(deckId, cardId){
  return {
    key: `${deckId}:${cardId}`,
    deckId,
    cardId,
    reps: 0,
    intervalDays: 0,
    ease: 2.3,
    dueAt: 0,        // 0 = nuevo
    lapses: 0,
    lastAt: 0
  };
}

// grade: 0..3  (0=mal, 1=difícil, 2=bien, 3=fácil)
export function applyReview(progress, grade){
  const now = Date.now();
  const p = { ...progress, lastAt: now };

  if (grade === 0) {
    p.lapses += 1;
    p.reps = 0;
    p.intervalDays = 1;
    p.ease = Math.max(1.3, p.ease - 0.2);
    p.dueAt = now + 1 * 24*3600*1000;
    return p;
  }

  // Ajuste de ease
  if (grade === 1) p.ease = Math.max(1.3, p.ease - 0.05);
  if (grade === 2) p.ease = Math.min(2.8, p.ease + 0.0);
  if (grade === 3) p.ease = Math.min(2.8, p.ease + 0.08);

  p.reps += 1;

  if (p.reps === 1) p.intervalDays = 1;
  else if (p.reps === 2) p.intervalDays = 3;
  else p.intervalDays = Math.round(p.intervalDays * p.ease);

  p.dueAt = now + p.intervalDays * 24*3600*1000;
  return p;
}

// Selección para juego (Pasapalabra):
// - Prioriza due (vencidas) + nuevas
// - Reduce repetición reciente (si lastAt es muy reciente)
export function scoreForGame(progress){
  const now = Date.now();
  const due = progress.dueAt === 0 ? 0 : progress.dueAt;
  const isNew = progress.dueAt === 0;
  const overdueDays = due ? Math.max(0, (now - due) / (24*3600*1000)) : 0;

  const recentPenalty = progress.lastAt ? Math.max(0, 1 - (now - progress.lastAt) / (6*3600*1000)) : 0;
  // score alto = más probable
  let score = 1;

  if (isNew) score += 2.2;
  score += Math.min(4, overdueDays);       // vencidas suben
  score += Math.max(0, 2 - progress.reps); // poco vistas suben
  score -= recentPenalty * 2.0;            // si acaba de salir, baja

  return Math.max(0.01, score);
}
