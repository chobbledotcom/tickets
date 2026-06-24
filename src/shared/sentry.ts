/**
 * Sentry error reporting (server-side only)
 *
 * Forwards the same classified server errors that log to the console and ping
 * ntfy to a Sentry-compatible endpoint (the DSN in `SENTRY_URL`, e.g. a
 * self-hosted Bugsink). When an error carries its original exception, Sentry
 * receives the real stack trace; otherwise it gets the formatted message.
 *
 * The SDK is initialized once at startup and only when `SENTRY_URL` is set, so
 * local development and tests never send anything. All default integrations are
 * disabled (`integrations: []`): they read Deno-specific globals and source
 * files we don't need, and turning them off keeps the SDK to its core capture +
 * fetch transport, which is exactly what the edge runtime supports.
 */

import * as Sentry from "@sentry/deno";
import { BUILD_COMMIT } from "#shared/build-info.ts";
import { getEnv } from "#shared/env.ts";
import { type ErrorContext, formatErrorMessage } from "#shared/logger.ts";

/** How long to wait for queued events to reach Sentry before giving up (ms). */
const FLUSH_TIMEOUT_MS = 2000;

/**
 * Build the release identifier Sentry groups events (and source maps) by.
 * Uses the CI commit SHA baked into the build; undefined in dev (empty commit),
 * which Sentry treats as "no release".
 */
export const releaseFromCommit = (commit: string): string | undefined =>
  commit ? `chobble-tickets@${commit}` : undefined;

/**
 * Initialize the Sentry SDK. No-op (returns false) when `SENTRY_URL` is unset.
 * Safe to call more than once: only the first call with a DSN initializes.
 */
export const initSentry = (): boolean => {
  const dsn = getEnv("SENTRY_URL");
  if (!dsn) return false;
  if (Sentry.isInitialized()) return true;

  Sentry.init({
    dsn,
    integrations: [],
    release: releaseFromCommit(BUILD_COMMIT),
    tracesSampleRate: 0,
  });
  return true;
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
  if (!Sentry.isInitialized()) return;

  const captureContext = {
    extra: context.detail ? { detail: context.detail } : undefined,
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

/**
 * Tear down the SDK so the global client doesn't leak between test files.
 * Production never calls this — the client lives for the process lifetime.
 */
export const resetSentryForTest = (): void => {
  const scopes = [
    Sentry.getCurrentScope(),
    Sentry.getGlobalScope(),
    Sentry.getIsolationScope(),
  ];
  for (const scope of scopes) scope.setClient(undefined);
};
