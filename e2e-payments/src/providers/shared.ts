import type { BrowserSession } from "../browser.ts";
import type { ProviderName } from "../config.ts";
import { config } from "../config.ts";
import { log } from "../log.ts";

/** Select the active payment provider via the radio form on /admin/settings. */
export const selectProvider = async (
  session: BrowserSession,
  provider: ProviderName,
): Promise<void> => {
  await session.goto("/admin/settings");
  await session.check("payment_provider", provider);
  await session.clickButton("Save Payment Provider");
  log(`  selected payment provider: ${provider}`);
};

/**
 * Confirm the credentials saved: each provider renders a "Test Connection"
 * button (id `<provider>-test-btn`) only once its key/token is configured.
 */
export const assertConfigured = async (
  session: BrowserSession,
  provider: ProviderName,
): Promise<void> => {
  const marker = session.page.locator(`#${provider}-test-btn`);
  try {
    await marker.waitFor({ state: "visible", timeout: config.navTimeoutMs });
    log(`  ${provider} credentials accepted`);
  } catch (err) {
    await session.screenshot(`configure-${provider}-failed`);
    const body = await session.bodyText();
    throw new Error(
      `${provider} did not report as configured after saving credentials.\n` +
        `Page said:\n${body.slice(0, 1_200)}\n(original: ${String(err)})`,
    );
  }
};
