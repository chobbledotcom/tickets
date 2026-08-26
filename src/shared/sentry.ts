/**
 * Sentry error reporting (server-side only). Forwards the same classified
 * server errors that log to the console and ping ntfy to a Sentry-compatible
 * endpoint (the DSN in `SENTRY_URL`, for example a self-hosted Bugsink). When
 * an error carries its original exception, Sentry receives the real stack
 * trace, otherwise it gets the formatted message.
 *
 * The SDK is a large module, so a narrow named-import adapter is dynamically
 * imported on the first `initSentry` call with a DSN configured, never at
 * module load. That lets the production build remove unused SDK exports, and a
 * deployment without `SENTRY_URL` skips the retained code entirely. It also
 * names the integrations a report needs, which a bare client does not add.
 *
 * Every report names the site, the route, and the request id the console lines
 * carry, so one endpoint can serve many sites and still lead back to a request.
 */

import { lazyRef } from "#fp";
import { BUILD_COMMIT } from "#shared/build-info.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { getEnv } from "#shared/env.ts";
import {
  type ErrorContext,
  formatErrorMessage,
  getRequestId,
} from "#shared/logger.ts";
import {
  getRequestTrace,
  getTracedRoute,
  getTracedUrl,
} from "#shared/request-trace.ts";

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

/**
 * Per-event tags, so a report can be filtered by class, by site, and by
 * request. `site` names which of our sites reported it, because many sites
 * share one Sentry endpoint. `requestId` is the same four characters the
 * console lines carry, so a report leads back to the log beside it. Empty and
 * missing values are dropped rather than sent as blanks.
 */
const eventTags = (context: ErrorContext): Record<string, string> => {
  const trace = getRequestTrace();
  return Object.fromEntries(
    Object.entries({
      attendeeId: context.attendeeId,
      code: context.code,
      listingId: context.listingId,
      requestId: getRequestId(),
      // The host the visitor actually asked for. Outside a request — boot, a
      // scheduled run — the site's own configured domain, which is the one
      // the ntfy notification titles already use.
      site: trace ? trace.host : getEffectiveDomain(),
      url: getTracedUrl(),
    })
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, String(value)]),
  );
};

/**
 * How to group a report that carries no exception.
 *
 * A message report has no stack, so Sentry groups it by the message text — and
 * our text ends with a detail that names the image, the session, or the
 * amount. That made one issue per detail: forty separate "Broken image"
 * issues, none of them a place to look. Grouping by the error code and the
 * route puts every one of them in a single issue with forty events.
 *
 * A report that carries an exception keeps the SDK's own stack grouping, which
 * is already the right answer.
 */
const messageFingerprint = (context: ErrorContext): string[] => {
  if (context.error !== undefined) return [];
  const trace = getRequestTrace();
  return trace ? [context.code, trace.method, trace.route] : [context.code];
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

  Sentry.captureReport({
    error: context.error,
    extra: context.detail ? { detail: context.detail } : {},
    fingerprint: messageFingerprint(context),
    message: formatErrorMessage(context),
    tags: eventTags(context),
    transactionName: getTracedRoute(),
  });

  await Sentry.flush(FLUSH_TIMEOUT_MS);
};
