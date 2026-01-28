export async function renderEditor(root){
  root.innerHTML = `
    <div class="card">
      <h2>Editor (estilo Anki)</h2>
      <p>En el siguiente bloque implementamos creación de mazos del usuario + import/export.</p>

      <div class="grid" style="margin-top:12px">
        <label>
          <div style="margin-bottom:6px;color:var(--muted)">Pregunta</div>
          <textarea class="input" placeholder="Ej: Capital de Australia"></textarea>
        </label>
        <label>
          <div style="margin-bottom:6px;color:var(--muted)">Respuesta</div>
          <input class="input" placeholder="Ej: Canberra" />
        </label>

        <div class="row">
          <button class="btn primary" disabled>Guardar tarjeta (próximo paso)</button>
          <button class="btn" disabled>Importar CSV/JSON (próximo paso)</button>
          <button class="btn" disabled>Exportar (próximo paso)</button>
        </div>
      </div>
    </div>
  `;
}
