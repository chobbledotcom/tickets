/**
 * Central configuration for the payment sandbox e2e harness.
 *
 * Everything the harness needs is read from the environment so the same code
 * runs locally and in CI. Secrets are only ever read here (never logged).
 */

export type ProviderName = "stripe" | "square" | "sumup";

/** Which flow to run: a real provider, or "free" (harness self-test, no money). */
export type Target = ProviderName | "free";

const env = (key: string): string | undefined => {
  const v = process.env[key];
  return v && v.trim() !== "" ? v.trim() : undefined;
};

const bool = (key: string, fallback: boolean): boolean => {
  const v = env(key);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
};

const num = (key: string, fallback: number): number => {
  const v = env(key);
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  /** Deno binary used to boot the app server. */
  denoBin: env("DENO_BIN") ?? "deno",
  /** cloudflared binary used for the public webhook/return-URL tunnel. */
  cloudflaredBin: env("CLOUDFLARED_BIN") ?? "cloudflared",
  /**
   * Path to a Chromium executable. The managed environment pre-installs one at
   * /opt/pw-browsers/chromium; CI installs its own via `playwright install` and
   * leaves this unset so Playwright resolves the bundled build.
   */
  chromiumExecutable: env("CHROMIUM_EXECUTABLE"),
  headless: bool("HEADLESS", true),

  /** 32-byte base64 key. Defaults to the repo's well-known test key. */
  dbEncryptionKey:
    env("DB_ENCRYPTION_KEY") ??
    "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",

  /** Admin credentials created by the setup wizard. Password must be 8+ chars. */
  adminUsername: env("ADMIN_USERNAME") ?? "admin",
  adminPassword: env("ADMIN_PASSWORD") ?? "password",
  /**
   * Email used for the booking. NOT a reserved domain: `example.com` is
   * rejected by some payment processors (Square returns "invalid email"), so
   * default to a real, disposable-mail domain.
   */
  bookerEmail: env("E2E_BOOKER_EMAIL") ?? "e2e-booker@mailinator.com",
  /**
   * ISO country picked in setup — determines the site currency. Must map to a
   * 2-decimal currency (GBP/USD/EUR, as the provider defaults do): the price
   * entry and paid-amount assertion assume minor units are hundredths, so a
   * zero-decimal currency (e.g. JPY via JP) is unsupported.
   */
  setupCountry: env("SETUP_COUNTRY") ?? "GB",

  /**
   * Ticket price in minor units (e.g. 137 = £1.37 / $1.37). Deliberately a
   * non-round amount: the admin income ledger formats via `stripIfInteger`, so
   * a whole price like 100 would render "£1" (no decimals) — a non-round price
   * keeps its decimals, making the paid-amount assertion specific.
   */
  unitPrice: num("E2E_UNIT_PRICE", 137),

  /** Timeouts (ms). Hosted checkout pages can be slow, so keep these generous. */
  serverBootTimeoutMs: num("E2E_SERVER_BOOT_TIMEOUT_MS", 60_000),
  tunnelTimeoutMs: num("E2E_TUNNEL_TIMEOUT_MS", 60_000),
  /** How many times to (re)spawn cloudflared before giving up. trycloudflare
   * quick tunnels intermittently fail to register, so retry rather than fail
   * the whole leg on the first miss. */
  tunnelAttempts: num("E2E_TUNNEL_ATTEMPTS", 3),
  navTimeoutMs: num("E2E_NAV_TIMEOUT_MS", 45_000),
  /** Per-element action timeout. Kept short: with force interactions an element
   * is acted on as soon as it is attached, so a long wait here only delays a
   * genuine failure (and its screenshot). */
  actionTimeoutMs: num("E2E_ACTION_TIMEOUT_MS", 15_000),
  paymentConfirmTimeoutMs: num("E2E_PAYMENT_CONFIRM_TIMEOUT_MS", 90_000),

  /** Force the tunnel on/off. Stripe always needs it; default follows target. */
  forceTunnel: env("E2E_TUNNEL"),

  /** Where to drop screenshots / server logs on failure. */
  artifactsDir: env("E2E_ARTIFACTS_DIR") ?? "artifacts",
};

/** Whether a public tunnel is required for the given target. */
export const needsTunnel = (target: Target): boolean => {
  if (config.forceTunnel !== undefined) {
    return config.forceTunnel === "1" || config.forceTunnel === "true";
  }
  // Stripe registers its webhook endpoint against a public HTTPS URL at config
  // time, so it cannot be set up without a tunnel. Square/SumUp confirm via the
  // browser return URL, which providers expect to be a public HTTPS URL — hence
  // the tunnel for them too. Note the tunnel does NOT mean any leg *asserts*
  // webhook delivery: confirmation is asserted via the return URL for every
  // provider (Stripe additionally exercises webhook registration, but delivery
  // is not asserted). Square's webhook needs a manually-signed subscription and
  // is not tested here; SumUp needs no
  // signature. See the providers' notes and the README.
  return target !== "free";
};

/** Read the secrets for a provider; returns null if any required one is absent. */
export const providerSecrets = (
  provider: ProviderName,
): Record<string, string> | null => {
  if (provider === "stripe") {
    const key = env("STRIPE_SECRET_KEY");
    if (!key) return null;
    // Fail closed unless this is a Stripe test-mode secret key. The harness
    // registers webhook endpoints and creates checkout sessions, which must
    // never touch a live account. Match the app exactly: detectStripeKeyMode
    // (src/shared/stripe.ts) only recognises sk_test_/sk_live_, so accepting a
    // restricted rk_test_ key here would just fail confusingly at the settings
    // form. Require sk_test_.
    if (!key.startsWith("sk_test_")) {
      throw new Error(
        "STRIPE_SECRET_KEY is not a Stripe test-mode secret key (expected sk_test_). " +
          "Refusing to run the sandbox harness against a live or unrecognised key.",
      );
    }
    return { secretKey: key };
  }
  if (provider === "square") {
    const token = env("SQUARE_ACCESS_TOKEN");
    const locationId = env("SQUARE_LOCATION_ID");
    if (!token || !locationId) return null;
    return { token, locationId, sandbox: bool("SQUARE_SANDBOX", true) ? "true" : "false" };
  }
  // sumup
  const apiKey = env("SUMUP_API_KEY");
  const merchantCode = env("SUMUP_MERCHANT_CODE");
  if (!apiKey || !merchantCode) return null;
  return { apiKey, merchantCode };
};
