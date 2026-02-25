/**
 * Header image state for sync access by JSX templates
 *
 * The header image URL is loaded from settings and stored for sync access
 * by the Layout component. Called once per request in routes/index.ts
 * before templates render.
 */

import { getHeaderImageUrlFromDb } from "#lib/db/settings.ts";

/** Sync-accessible header image URL, populated by loadHeaderImage() */
const state = { url: null as string | null };

/**
 * Load header image URL from settings into sync-accessible state.
 * Called once per request in routes/index.ts before templates render.
 * Settings are already cached so this is cheap on repeat calls.
 */
export const loadHeaderImage = async (): Promise<string | null> => {
  state.url = await getHeaderImageUrlFromDb();
  return state.url;
};

/** Get the current header image URL, or null if not set */
export const getHeaderImageUrl = (): string | null => state.url;

/** For testing: set the header image URL directly */
export const setHeaderImageForTest = (url: string | null): void => {
  state.url = url;
};

/** For testing: reset the header image state */
export const resetHeaderImage = (): void => {
  state.url = null;
};
