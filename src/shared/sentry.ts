/**
 * Sentry error reporting (server-side only)
 *
 * Forwards the same classified server errors that log to the console and ping
 * ntfy to a Sentry-compatible endpoint (the DSN in `SENTRY_URL`, e.g. a
 * self-hosted Bugsink). When an error carries its original exception, Sentry
 * receives the real stack trace; otherwise it gets the formatted message.
 *
 * The SDK is a large module, so — like the Stripe SDK in `stripe.ts` — a narrow
 * named-import adapter is dynamically imported on the first `initSentry` call
 * with a DSN configured, never at module load. The adapter lets the production
 * build remove unused SDK exports while a deployment without `SENTRY_URL`
 * skips evaluating the retained code entirely. All default integrations are
 * disabled (`integrations: []`): they read Deno-specific globals and source files we
 * don't need, and turning them off keeps the SDK to its core capture + fetch
 * transport, which is exactly what the edge runtime supports.
 */

import { lazyRef } from "#fp";
import { BUILD_COMMIT } from "#shared/build-info.ts";
import { getEnv } from "#shared/env.ts";
import { type ErrorContext, formatErrorMessage } from "#shared/logger.ts";

type SentrySdk = typeof import("#shared/sentry-sdk.ts")["sentrySdk"];
type LoadedSentry = {
  client: ReturnType<SentrySdk["init"]>;
  sdk: SentrySdk;
};

/** The loaded SDK and initialized client, or null while Sentry is off. */
const [getLoadedSentry, setLoadedSentry] = lazyRef<LoadedSentry | null>(
  () => null,
);

/** How long to wait for queued events to reach Sentry before giving up (ms). */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Build the release identifier Sentry groups events (and source maps) by.
 * Uses the CI commit SHA baked into the build; undefined in dev (empty commit),
 * which Sentry treats as "no release".
 */
export const releaseFromCommit = (commit: string): string | undefined =>
  commit ? `chobble-tickets@${commit}` : undefined;

/** Load and initialize the configured SDK, or return null when Sentry is off. */
const loadSentry = async (): Promise<LoadedSentry | null> => {
  const dsn = getEnv("SENTRY_URL");
  if (!dsn) return null;

  const loaded = getLoadedSentry();
  if (loaded?.sdk.isInitialized()) return loaded;

  const sdk = (await import("#shared/sentry-sdk.ts")).sentrySdk;
  const next = {
    client: sdk.init({
      dsn,
      release: releaseFromCommit(BUILD_COMMIT),
    }),
    sdk,
  };
  setLoadedSentry(next);
  return next;
};

/**
 * Initialize the Sentry SDK. No-op (returns false) when `SENTRY_URL` is unset —
 * without even loading the SDK. Safe to call more than once: only the first
 * call with a DSN loads and initializes.
 */
export const initSentry = async (): Promise<boolean> =>
  (await loadSentry()) !== null;

/** Send a real test error and wait for the Sentry transport to finish. */
export const sendSentryTest = async (): Promise<boolean> => {
  const loaded = await loadSentry();
  if (!loaded) return false;
  const { client, sdk: Sentry } = loaded;

  let eventId: string | undefined;
  return new Promise<boolean>((resolve) => {
    const stopListening = client.on("afterSendEvent", (event, response) => {
      if (event.event_id !== eventId) return;
      const status = response.statusCode;
      finish(status !== undefined && status >= 200 && status < 300);
    });
    const timeout = setTimeout(() => finish(false), FLUSH_TIMEOUT_MS);
    function finish(accepted: boolean): void {
      clearTimeout(timeout);
      stopListening();
      resolve(accepted);
    }
    eventId = Sentry.captureException(
      new Error("Test Sentry notification from the admin debug page."),
      {
        level: "error",
        tags: { source: "admin-debug", test: "true" },
      },
    );
  });
};

/** Per-event tags so errors can be filtered by class in the Sentry UI. */
const eventTags = (context: ErrorContext): Record<string, string> => {
  const tags: Record<string, string> = { code: context.code };
  if (context.listingId !== undefined) {
    tags.listingId = String(context.listingId);
  }
  if (context.attendeeId !== undefined) {
    tags.attendeeId = String(context.attendeeId);
  }
  return tags;
};

/**
 * Forward a classified server error to Sentry, if initialized. Captures the
 * original exception (preserving its stack trace) when one is attached to the
 * context, otherwise sends the formatted message. Resolves once queued events
 * have flushed so callers can await delivery as request-scoped pending work.
 */
export const captureServerError = async (
  context: ErrorContext,
): Promise<void> => {
  const loaded = getLoadedSentry();
  if (!loaded?.sdk.isInitialized()) return;
  const Sentry = loaded.sdk;

  const captureContext = {
    ...(context.detail ? { extra: { detail: context.detail } } : {}),
    level: "error" as const,
    tags: eventTags(context),
  };

  if (context.error !== undefined) {
    Sentry.captureException(context.error, captureContext);
  } else {
    Sentry.captureMessage(formatErrorMessage(context), captureContext);
  }

  await Sentry.flush(FLUSH_TIMEOUT_MS);
};
