// Placeholder para futuro: login + sync.
// La idea es que más adelante puedas cambiar el "store" de local a remoto sin reescribir todo.
export const Auth = {
  isEnabled: false,
  async currentUser(){ return null; },
  async login(){ throw new Error("Auth no habilitado en MVP"); },
  async logout(){ return true; }
};
