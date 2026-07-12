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

/**
 * Demo mode banner HTML, built on demand.
 *
 * Deliberately a function, not a module-level constant: calling `t()` at module
 * scope would construct the isolate's first `IntlMessageFormat` at import time,
 * and that first construction loads ~13ms of ICU locale data. Since the layout
 * imports this module on every page, a module-level `t()` here would pay that
 * ICU init on every cold boot — before the request is even routed — for a banner
 * that only ever shows in demo mode. As a function it runs only when the banner
 * is actually rendered (and the layout already gates it on `isDemoMode()`), so
 * requests that render nothing (webhooks, redirects, health checks) never pay it.
 */
export const demoBanner = (): string =>
  `<div class="demo-banner">${t("common.demo_mode_notice")}</div>`;
