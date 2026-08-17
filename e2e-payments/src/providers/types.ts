/* jscpd:ignore-start */
import type { Page } from "playwright";
import type { BrowserSession } from "#e2e/browser.ts";
import type { ProviderName } from "#e2e/config.ts";

export type { ProviderName };
/* jscpd:ignore-end */

/**
 * Drive a provider's *hosted* checkout page and return its exact identity.
 * See `PaymentProvider.payHostedCheckout` for the full contract.
 */
export type PayHostedCheckout = (
  page: Page,
  ctx: HostedCheckoutContext,
) => Promise<PaidSandboxCheckout>;

/**
 * Set a provider up through the admin UI, using the browser session and the
 * provider's secrets. Throws on failure.
 */
export type ConfigureProvider = (
  session: BrowserSession,
  secrets: Record<string, string>,
) => Promise<void>;

/**
 * The exact identity a completed paid checkout must hand back: who processed
 * it, the saved return URL the checkout produced, and the provider resource
 * ids this scenario owns. Every later provider read and cleanup is scoped to
 * these ids — never to "the latest payment in the account".
 */
export type PaidSandboxCheckout =
  | {
      provider: "stripe";
      returnUrl: string;
      checkoutSessionId: string;
      paymentIntentId: string;
    }
  | {
      provider: "square";
      returnUrl: string;
      orderId: string;
      paymentId: string;
    }
  | {
      provider: "sumup";
      returnUrl: string;
      checkoutId: string;
      transactionId: string;
    };

/**
 * A read-only look at the exact checkout's refund. `completed` carries the
 * actually returned amount and currency; a refund that may have landed but is
 * not yet observable is honestly `pending` with the observation time — never
 * reported as complete, never defaulted to zero.
 */
export type SandboxRefundObservation =
  | {
      kind: "completed";
      returnedAmount: number;
      currency: string;
    }
  | {
      kind: "pending";
      observedAt: string;
    };

/**
 * Runtime context handed to `payHostedCheckout` alongside the browser page.
 * Most providers just drive the page and ignore this, but a provider whose
 * sandbox has no browser-drivable hosted card page (Square) needs the app's
 * public base URL, its server log (to recover the provider-side id the app
 * created), and the sandbox secrets to finish the payment out-of-band.
 */
export interface HostedCheckoutContext {
  /** Public base URL the browser drives the app at (the cloudflared tunnel). */
  baseUrl: string;
  /** The provider's sandbox secrets (as returned by providerSecrets). */
  secrets: Record<string, string>;
  /** Path to the app server's log file (provider ids are logged there). */
  serverLogPath: string;
}

/** The provider-owned resources one scenario created and must clean up. */
export interface OwnedProviderResources {
  /** This scenario's exact public base URL (tunnel) — never an account sweep. */
  publicBaseUrl: string;
}

/** A paid sandbox driver. Free bookings never touch this interface. */
export interface PaymentProvider {
  /**
   * Remove provider-owned ephemeral resources for this exact scenario (e.g.
   * the Stripe webhook endpoint pointing at this scenario's tunnel URL).
   * Throws on failure — cleanup errors fail scenarios, they are not best-effort.
   */
  cleanup: (
    owned: OwnedProviderResources,
    secrets: Record<string, string>,
  ) => Promise<void>;
  /**
   * Configure the provider through the admin UI: select it as the active
   * payment provider, then save its credentials. Throws on failure.
   */
  configure: ConfigureProvider;
  name: ProviderName;
  /**
   * Read — never send — the refund state of the exact checkout, scoped to the
   * ids that checkout returned. Read-only by construction: no driver method
   * moves money.
   */
  observeRefund: (
    checkout: PaidSandboxCheckout,
    secrets: Record<string, string>,
  ) => Promise<SandboxRefundObservation>;
  /**
   * Drive the provider's *hosted* checkout page: enter the sandbox test card
   * and submit, then return the exact checkout identity (including the saved
   * return URL). The page is already navigated to the provider's domain.
   * A missing documented field in a provider response throws here — it never
   * becomes an empty id.
   */
  payHostedCheckout: PayHostedCheckout;
  /**
   * The site currency the provider sandbox expects, as an ISO country code for
   * the setup wizard (GB→GBP, US→USD). Sandbox account currency must match.
   */
  setupCountry: string;
}
