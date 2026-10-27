/**
 * Central configuration for the payment sandbox e2e harness.
 *
 * Everything the harness needs is read from the environment so the same code
 * runs locally and in CI. Secrets are only ever read here (never logged).
 */

export type ProviderName = "stripe" | "square" | "sumup";

/** Which flow to run: a real provider, or "free" (harness self-test, no money). */
export type Target = ProviderName | "free";

/** One environment lookup: a key to its raw value, or undefined when unset. */
export type EnvLookup = (key: string) => string | undefined;

/** Read one variable from the process environment. */
const processEnv = (key: string): string | undefined => process.env[key];

/** The trimmed value of an env var, or undefined when it is unset or blank. */
const envValue = (lookup: EnvLookup, key: string): string | undefined => {
  const v = lookup(key);
  return v && v.trim() !== "" ? v.trim() : undefined;
};

/** Parse a boolean env var: "1", "true", or "yes" (any case) mean true. */
const envBool = (raw: string | undefined, fallback: boolean): boolean => {
  if (raw === undefined) return fallback;
  return (
    raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes"
  );
};

/** Parse a numeric env var, falling back when it is absent or not finite. */
const envNum = (raw: string | undefined, fallback: number): number => {
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** A short lowercase identity fragment, unique per run/scenario. */
export const randomId = (bytes = 5): string =>
  crypto
    .getRandomValues(new Uint8Array(bytes))
    .reduce((acc, b) => acc + b.toString(16).padStart(2, "0"), "");

/** Admin credentials for one scenario's fresh install. Password must be 8+. */
export interface OwnerCredentials {
  password: string;
  username: string;
}

/** Random owner credentials — never the repository-known defaults, because a
 * tunneled app is briefly public. */
export const randomOwnerCredentials = (): OwnerCredentials => {
  const id = randomId();
  return { password: `E2e!${randomId(8)}`, username: `e2e-${id}` };
};

/** The unique booker identity one scenario books with. */
export interface BookerIdentity {
  email: string;
  name: string;
}

/** A fresh, provider-acceptable booker email and name, unique to this run. */
export const newBookerIdentity = (runId: string): BookerIdentity => ({
  email: `e2e-${runId}-${randomId(3)}@mailinator.com`,
  name: `E2E Booker ${randomId(3)}`,
});

/** The harness config snapshot: every value the harness reads from the
 * environment once per process, with its fallback for an unset key. */
export interface HarnessConfig {
  actionTimeoutMs: number;
  artifactsDir: string;
  chromiumExecutable: string | undefined;
  cloudflaredBin: string;
  dbEncryptionKey: string;
  denoBin: string;
  forceTunnel: string | undefined;
  headless: boolean;
  hostedPaymentStepTimeoutMs: number;
  navTimeoutMs: number;
  paymentConfirmTimeoutMs: number;
  sentryUrl: string | undefined;
  serverBootTimeoutMs: number;
  setupCountry: string;
  startupTimeoutMs: number;
  stepTimeoutMs: number;
  teardownTimeoutMs: number;
  tunnelAttempts: number;
  tunnelTimeoutMs: number;
  unitPrice: number;
}

/** Build the harness config snapshot from an environment lookup. The lookup is
 * the injectable seam: direct tests drive the parsing branches in-process, and
 * the process reads its own environment once at module load. */
export const readConfig = (lookup: EnvLookup): HarnessConfig => {
  const env = {
    bool: (key: string, fallback: boolean): boolean =>
      envBool(envValue(lookup, key), fallback),
    num: (key: string, fallback: number): number =>
      envNum(envValue(lookup, key), fallback),
    text: (key: string): string | undefined => envValue(lookup, key),
  };
  return {
    /** Per-element action timeout for ordinary application controls. */
    actionTimeoutMs: env.num("E2E_ACTION_TIMEOUT_MS", 15_000),

    /** Where screenshots, journals, and server logs land (under e2e-payments). */
    artifactsDir: env.text("E2E_ARTIFACTS_DIR") ?? "artifacts",
    /**
     * Path to a Chromium executable. The managed environment pre-installs one at
     * /opt/pw-browsers/chromium; CI installs its own via `playwright install` and
     * leaves this unset so Playwright resolves the bundled build.
     */
    chromiumExecutable: env.text("CHROMIUM_EXECUTABLE"),
    /** cloudflared binary used for the public webhook/return-URL tunnel. */
    cloudflaredBin: env.text("CLOUDFLARED_BIN") ?? "cloudflared",

    /** 32-byte base64 key. Defaults to the repo's well-known test key. */
    dbEncryptionKey:
      env.text("DB_ENCRYPTION_KEY") ??
      "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    /** Deno binary used to boot the app server. */
    denoBin: env.text("DENO_BIN") ?? "deno",

    /** Force the tunnel on/off for local runs (`1`/`0`); default follows target. */
    forceTunnel: env.text("E2E_TUNNEL"),
    headless: env.bool("HEADLESS", true),
    /** The one step allowance big enough for the slow hosted-payment step. */
    hostedPaymentStepTimeoutMs: env.num(
      "E2E_HOSTED_PAYMENT_TIMEOUT_MS",
      240_000,
    ),
    navTimeoutMs: env.num("E2E_NAV_TIMEOUT_MS", 45_000),
    paymentConfirmTimeoutMs: env.num("E2E_PAYMENT_CONFIRM_TIMEOUT_MS", 90_000),

    /** Sentry DSN for the operator's bug catcher; a harness crash reports there. */
    sentryUrl: env.text("SENTRY_URL"),

    /** Timeouts (ms). Hosted checkout pages can be slow, so keep these generous. */
    serverBootTimeoutMs: env.num("E2E_SERVER_BOOT_TIMEOUT_MS", 60_000),
    /**
     * ISO country picked in setup — determines the site currency. Must map to a
     * 2-decimal currency (GBP/USD/EUR, as the provider defaults do): the price
     * entry and paid-amount assertion assume minor units are hundredths, so a
     * zero-decimal currency (e.g. JPY via JP) is unsupported.
     */
    setupCountry: env.text("SETUP_COUNTRY") ?? "GB",
    /** Bounded startup allowance for the Before hook's server+tunnel+browser. */
    startupTimeoutMs: env.num("E2E_STARTUP_TIMEOUT_MS", 300_000),
    /**
     * The bounded Cucumber step timeout for this harness (Cucumber's own default
     * is five seconds, far below real browser/provider allowances). Hooks set
     * their own explicit timeouts; only the genuinely long hosted-payment step
     * carries a larger one.
     */
    stepTimeoutMs: env.num("E2E_STEP_TIMEOUT_MS", 120_000),
    /** Bounded teardown allowance for the After hook's full resource sweep. */
    teardownTimeoutMs: env.num("E2E_TEARDOWN_TIMEOUT_MS", 120_000),
    /** How many times to (re)spawn cloudflared before giving up. trycloudflare
     * quick tunnels intermittently fail to register, so retry rather than fail
     * the whole leg on the first miss. */
    tunnelAttempts: env.num("E2E_TUNNEL_ATTEMPTS", 3),
    tunnelTimeoutMs: env.num("E2E_TUNNEL_TIMEOUT_MS", 60_000),

    /**
     * Ticket price in minor units (e.g. 137 = £1.37 / $1.37). Deliberately a
     * non-round amount: the admin income ledger formats via `stripIfInteger`, so
     * a whole price like 100 would render "£1" (no decimals) — a non-round price
     * keeps its decimals, making the paid-amount assertion specific.
     */
    unitPrice: env.num("E2E_UNIT_PRICE", 137),
  };
};

/** The config snapshot for this process, read once at module load. */
export const config = readConfig(processEnv);

/** Whether a public tunnel is required for the given target. */
export const needsTunnel = (
  target: Target,
  forceTunnel: string | undefined = config.forceTunnel,
): boolean => {
  if (forceTunnel !== undefined) {
    return forceTunnel === "1" || forceTunnel === "true";
  }
  // Stripe registers its webhook endpoint against a public HTTPS URL at config
  // time, so it cannot be set up without a tunnel. Square/SumUp confirm via the
  // browser return URL, which providers expect to be a public HTTPS URL — hence
  // the tunnel for them too. The free target runs on the local URL only.
  return target !== "free";
};

/**
 * Read the secrets for a paid provider. A missing secret is a failed nightly
 * contract, not a skip: this throws before any browser or provider call. The
 * workflow passes only the selected provider's credentials into each job, so
 * another provider's usable credential is never even present.
 */
export const providerSecrets = (
  provider: ProviderName,
): Record<string, string> => {
  if (provider === "stripe") {
    const key = envValue(processEnv, "STRIPE_SECRET_KEY");
    if (!key) {
      throw new Error(
        "STRIPE_SECRET_KEY is not set — the Stripe sandbox target cannot run. " +
          "Configure the repository secret; missing provider coverage fails the nightly contract.",
      );
    }
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
    const token = envValue(processEnv, "SQUARE_ACCESS_TOKEN");
    const locationId = envValue(processEnv, "SQUARE_LOCATION_ID");
    if (!token || !locationId) {
      throw new Error(
        "SQUARE_ACCESS_TOKEN/SQUARE_LOCATION_ID not set — the Square sandbox target cannot run. " +
          "Configure the repository secrets; missing provider coverage fails the nightly contract.",
      );
    }
    // The harness always drives the sandbox API base: there is no production
    // mode knob to leave enabled by mistake.
    return { locationId, token };
  }
  const apiKey = envValue(processEnv, "SUMUP_API_KEY");
  const merchantCode = envValue(processEnv, "SUMUP_MERCHANT_CODE");
  if (!apiKey || !merchantCode) {
    throw new Error(
      "SUMUP_API_KEY/SUMUP_MERCHANT_CODE not set — the SumUp sandbox target cannot run. " +
        "Configure the repository secrets; missing provider coverage fails the nightly contract.",
    );
  }
  return { apiKey, merchantCode };
};
