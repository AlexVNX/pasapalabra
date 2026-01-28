const DB_NAME = "entrenacoco";
const DB_VER = 1;
let db = null;

export async function initDB(){
  if (db) return db;

  db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);

    req.onupgradeneeded = () => {
      const d = req.result;

      // Decks: oficiales y usuario
      if (!d.objectStoreNames.contains("decks")) {
        d.createObjectStore("decks", { keyPath: "id" });
      }

      // Cards: guardamos por deckId+cardId
      if (!d.objectStoreNames.contains("cards")) {
        const s = d.createObjectStore("cards", { keyPath: "key" });
        s.createIndex("byDeck", "deckId", { unique:false });
      }

      // Progreso SRS: por deckId+cardId
      if (!d.objectStoreNames.contains("progress")) {
        const s = d.createObjectStore("progress", { keyPath: "key" });
        s.createIndex("byDeck", "deckId", { unique:false });
        s.createIndex("byDue", "dueAt", { unique:false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return db;
}

function tx(storeName, mode="readonly"){
  const t = db.transaction(storeName, mode);
  return t.objectStore(storeName);
}

export async function put(storeName, value){
  await initDB();
  return new Promise((resolve, reject) => {
    const req = tx(storeName, "readwrite").put(value);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

export async function get(storeName, key){
  await initDB();
  return new Promise((resolve, reject) => {
    const req = tx(storeName).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllByIndex(storeName, indexName, queryValue){
  await initDB();
  return new Promise((resolve, reject) => {
    const store = tx(storeName);
    const idx = store.index(indexName);
    const req = idx.getAll(queryValue);
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(storeName){
  await initDB();
  return new Promise((resolve, reject) => {
    const req = tx(storeName).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function del(storeName, key){
  await initDB();
  return new Promise((resolve, reject) => {
    const req = tx(storeName, "readwrite").delete(key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}
