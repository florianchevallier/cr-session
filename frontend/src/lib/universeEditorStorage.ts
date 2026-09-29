/**
 * Seul souvenir local : le dernier univers sélectionné. Les brouillons (lore, historique, table)
 * vivent sur le serveur, source de vérité partagée entre appareils.
 */
const SELECTED_UNIVERSE_KEY = "cr-session.selected-universe.v2";

export function loadSelectedUniverse(): string | null {
  try {
    return window.localStorage.getItem(SELECTED_UNIVERSE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function saveSelectedUniverse(universeId: string | null): void {
  try {
    if (universeId) window.localStorage.setItem(SELECTED_UNIVERSE_KEY, universeId);
    else window.localStorage.removeItem(SELECTED_UNIVERSE_KEY);
    window.localStorage.removeItem("cr-session.universe-editor.v1"); // ancien cache de brouillons
  } catch {
    // Stockage indisponible : on garde le sélecteur utilisable.
  }
}
