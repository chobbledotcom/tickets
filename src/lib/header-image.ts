/**
 * Header image test helpers
 *
 * Header image URL is read directly from settings.headerImageUrl.
 * These helpers exist for tests that need to override the value
 * without a test DB.
 */

import { settings } from "#lib/db/settings.ts";

/** For testing: set the header image URL directly */
export const setHeaderImageForTest = (url: string): void => {
  settings.setForTest({ headerImageUrl: url });
};

/** For testing: reset the header image state */
export const resetHeaderImage = (): void => {
  settings.clearTestOverride("headerImageUrl");
};
