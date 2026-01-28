import { put, get, getAllByIndex, getAll } from "./db.js";

const OFFICIAL_DECK_ID = "oficial-es-v1";

export async function ensureOfficialDeckLoaded(){
  const existing = await get("decks", OFFICIAL_DECK_ID);
  if (existing) return;

  const res = await fetch("./decks/oficiales.es.json");
  if (!res.ok) throw new Error("No se pudo cargar el mazo oficial");
  const deck = await res.json();

  // Guardar deck y cards
  await put("decks", {
    id: OFFICIAL_DECK_ID,
    title: deck.title,
    description: deck.description,
    lang: "es",
    kind: "official",
    updatedAt: Date.now()
  });

  for (const c of deck.cards) {
    await put("cards", {
      key: `${OFFICIAL_DECK_ID}:${c.id}`,
      deckId: OFFICIAL_DECK_ID,
      cardId: c.id,
      question: c.question,
      answer: c.answer,
      hint: c.hint || "",
      explanation: c.explanation || "",
      tags: c.tags || []
    });
  }
}

export async function listDecks(){
  return await getAll("decks");
}

export async function listCards(deckId){
  return await getAllByIndex("cards", "byDeck", deckId);
}

export function officialDeckId(){
  return OFFICIAL_DECK_ID;
}
