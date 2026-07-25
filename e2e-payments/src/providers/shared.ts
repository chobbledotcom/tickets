/* jscpd:ignore-start */
import { type BrowserSession, requirePageText } from "#e2e/browser.ts";
import type { ProviderName } from "#e2e/config.ts";
import { config } from "#e2e/config.ts";
import { BOOKER_NAME } from "#e2e/flow.ts";
import { log } from "#e2e/log.ts";
import type { ConfigureProvider, PayHostedCheckout } from "./types.ts";

/* jscpd:ignore-end */

/** A step that acts on the settings page for one named payment provider. */
type ProviderStep = (
  session: BrowserSession,
  provider: ProviderName,
) => Promise<void>;

/** Select the active payment provider via the radio form on /admin/settings. */
export const selectProvider: ProviderStep = async (session, provider) => {
  await session.goto("/admin/settings");
  await session.check("payment_provider", provider);
  await session.clickButton("Save Payment Provider");
  log(`  selected payment provider: ${provider}`);
};

/**
 * Confirm the credentials saved: each provider renders a "Test Connection"
 * button (id `<provider>-test-btn`) only once its key/token is configured.
 */
export const assertConfigured: ProviderStep = async (session, provider) => {
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

/**
 * Build a provider's `configure` from just its credential-saving step. Every
 * provider selects itself as the active provider, saves credentials, then
 * verifies it reports configured — only the middle step differs, so the
 * select/verify bookends live here rather than being repeated per provider.
 */
export const configureProvider =
  (
    provider: ProviderName,
    saveCredentials: ConfigureProvider,
  ): ConfigureProvider =>
  async (session, secrets) => {
    await selectProvider(session, provider);
    await saveCredentials(session, secrets);
    await assertConfigured(session, provider);
  };

/**
 * Build a provider's `payHostedCheckout` from just the step that drives its
 * hosted page. Every provider says what it is doing, then waits for the hosted
 * page's DOM before touching it — those two lines live here rather than being
 * repeated per provider, so each provider only writes its own driving step.
 */
export const hostedCheckout =
  (message: string, drive: PayHostedCheckout): PayHostedCheckout =>
  async (page, ctx) => {
    log(message);
    await page.waitForLoadState("domcontentloaded");
    await drive(page, ctx);
  };

/**
 * Exercise the admin refund flow after a paid booking: open the attendee,
 * refresh the payment status (polls the real provider API), then submit the
 * admin refund form and verify the refund is recorded. This exercises the
 * provider's real sandbox refund API (POST /v2/refunds for Square,
 * refunds.create for Stripe), the Valibot boundary validation, and the ledger
 * posting — the full round-trip from admin UI through provider to ledger.
 */
export const exerciseAdminRefund = async (
  session: BrowserSession,
): Promise<void> => {
  const attendee = session.page.getByRole("link", {
    exact: true,
    name: BOOKER_NAME,
  });
  const attendeeHref = await attendee.getAttribute("href");
  if (!attendeeHref) {
    throw new Error(`Could not open paid attendee "${BOOKER_NAME}"`);
  }
  await session.goto(attendeeHref);

  await session.clickButton("Refresh payment status");
  await requirePageText(
    session,
    "Payment status is up to date",
    "payment-status-failed",
    'Expected the app page to contain "Payment status is up to date"',
  );

  await session.clickLink("Actions");
  await session.clickLink("Refund");
  await session.fill("confirm_identifier", BOOKER_NAME);
  await session.clickButton("Refund Attendee");
  await requirePageText(
    session,
    "Refund issued",
    "refund-failed",
    'Expected the app page to contain "Refund issued"',
  );

  await session.clickLink("Overview");
  const paymentDetails = await session.page
    .locator(".prose", { hasText: "Payment Details" })
    .first()
    .innerText();
  if (
    !paymentDetails.includes("Refund Status:") ||
    !paymentDetails.includes("Refunded")
  ) {
    await session.dumpPage("refund-not-recorded");
    throw new Error(
      `Refund was not recorded on the attendee. Payment details:\n${paymentDetails}`,
    );
  }
  log("  refund, ledger recording, and status verification passed");
};
