/**
 * Theme state for sync access by JSX templates
 *
 * The theme is loaded from settings and stored for sync access
 * by the Layout component. Called once per request in routes/index.ts
 * before templates render.
 */

import { getThemeFromDb } from "#lib/db/settings.ts";
import type { Theme } from "#lib/types.ts";

/** Sync-accessible theme, populated by loadTheme() */
const state: { theme: Theme } = { theme: "light" };

/**
 * Load theme from settings into sync-accessible state.
 * Called once per request in routes/index.ts before templates render.
 * Settings are already cached so this is cheap on repeat calls.
 */
export const loadTheme = async (): Promise<Theme> => {
  state.theme = await getThemeFromDb();
  return state.theme;
};

/** Get the current theme ("light" or "dark") */
export const getTheme = (): Theme => state.theme;

/** For testing: set the theme directly */
export const setThemeForTest = (t: Theme): void => {
  state.theme = t;
};

/** For testing: reset the theme to default */
export const resetTheme = (): void => {
  state.theme = "light";
};
