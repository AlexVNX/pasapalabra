export function normalizeAnswer(s){
  if (!s) return "";
  return s
    .toLowerCase()
    .trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/[^\p{L}\p{N}\s]/gu, " ")               // limpia signos
    .replace(/\s+/g, " ")
    .trim();
}
