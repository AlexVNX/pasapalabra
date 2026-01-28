import { renderHome } from "./modes/home.js";
import { renderStudy } from "./modes/study.js";
import { renderPasapalabra } from "./modes/pasapalabra.js";
import { renderEditor } from "./modes/editor.js";

export function mountRoute(){
  const app = document.getElementById("app");
  if (!app) return;

  const hash = (location.hash || "#/").split("?")[0];

  if (hash === "#/study") return renderStudy(app);
  if (hash === "#/pasapalabra") return renderPasapalabra(app);
  if (hash === "#/editor") return renderEditor(app);
  return renderHome(app);
}
