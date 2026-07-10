/**
 * Demo mode flag and banner.
 *
 * Demo mode replaces user-entered text with sample data to prevent PII
 * storage. Enable by setting DEMO_MODE=true environment variable.
 *
 * This module is deliberately tiny: the page layout checks the flag on every
 * render, so it must not drag the sample-data pools (`#shared/demo/samples.ts`)
 * into every page's import graph.
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

/** Demo mode banner HTML */
export const DEMO_BANNER = `<div class="demo-banner">${t("guide.demo_mode_notice")}</div>`;
