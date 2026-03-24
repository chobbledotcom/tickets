/**
 * Theme test helpers
 *
 * Theme is read directly from settings.theme. These helpers exist
 * for tests that need to override the theme without a test DB.
 */

import { settings } from "#lib/db/settings.ts";
import type { Theme } from "#lib/types.ts";

/** For testing: set the theme directly */
export const setThemeForTest = (t: Theme): void => {
  settings.setForTest({ theme: t });
};

/** For testing: reset the theme to default */
export const resetTheme = (): void => {
  settings.clearTestOverride("theme");
};
