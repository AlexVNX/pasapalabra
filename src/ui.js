export function setStatus(msg){
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
}

export function setActiveTab(hash){
  document.querySelectorAll(".tabs a").forEach(a => a.classList.remove("active"));
  const map = {
    "#/":"Inicio",
    "#/study":"Repaso",
    "#/pasapalabra":"Pasapalabra",
    "#/ranking":"Ranking",
    "#/editor":"Editor"
  };
  const target = Array.from(document.querySelectorAll(".tabs a"))
    .find(a => a.getAttribute("href") === (hash || "#/"));
  if (target) target.classList.add("active");
}
