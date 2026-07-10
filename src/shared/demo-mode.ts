/**
 * The demo-mode flag and banner, on their own so that always-loaded code
 * (the page layout, settings pages) can ask "is this the demo site?"
 * without pulling in the generated demo data — building those word lists
 * is real work that would otherwise run on every isolate boot.
 * Enable by setting DEMO_MODE=true environment variable.
 */

import { lazyRef } from "#fp";
import { t } from "#i18n";
import { getEnv } from "#shared/env.ts";

const [getDemoMode, setDemoMode] = lazyRef(
  () => getEnv("DEMO_MODE") === "true",
);

/** Check if demo mode is enabled */
export const isDemoMode = (): boolean => getDemoMode();

/** Reset cached demo mode value (for testing and cache invalidation) */
export const resetDemoMode = (): void => setDemoMode(null);

/**
 * Explicitly set demo mode on or off (for testing).
 * Bypasses Deno.env to avoid races between parallel test workers.
 */
export const setDemoModeForTest = (enabled: boolean): void =>
  setDemoMode(enabled);

/** Banner shown at the top of every page while demo mode is on */
export const DEMO_BANNER = `<div class="demo-banner">${t("guide.demo_mode_notice")}</div>`;
