import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import type { ProviderName } from "../config.ts";

export interface PaymentProvider {
  name: ProviderName;
  /**
   * The site currency the provider sandbox expects, as an ISO country code for
   * the setup wizard (GB→GBP, US→USD). Sandbox account currency must match.
   */
  setupCountry: string;
  /**
   * Configure the provider through the admin UI: select it as the active
   * payment provider, then save its credentials. Throws on failure.
   */
  configure: (
    session: BrowserSession,
    secrets: Record<string, string>,
  ) => Promise<void>;
  /**
   * Drive the provider's *hosted* checkout page: enter the sandbox test card
   * and submit. The page is already navigated to the provider's domain.
   * Returns once the payment has been submitted and the browser is heading back
   * to the app's return URL.
   */
  payHostedCheckout: (page: Page) => Promise<void>;
  /**
   * Optional teardown against the provider's own account (not the app), run in
   * `finally` after each run. Used to remove ephemeral resources the run
   * created in the sandbox — e.g. the per-tunnel Stripe webhook endpoint.
   */
  cleanup?: (secrets: Record<string, string>) => Promise<void>;
}
