/**
 * The narrow Sentry surface used by the server error reporter.
 *
 * Keeping named SDK imports behind this lazy-loaded adapter lets esbuild remove
 * unused Sentry exports without evaluating the SDK during module load.
 */

import type { ErrorEvent } from "@sentry/core";
import {
  createStackParser,
  createTransport,
  nodeStackLineParser,
  type Scope,
} from "@sentry/core";
import {
  breadcrumbsIntegration,
  captureException,
  captureMessage,
  DenoClient,
  flush,
  getCurrentScope,
  getGlobalScope,
  getIsolationScope,
  isInitialized,
  linkedErrorsIntegration,
} from "@sentry/deno";
import { linesForRequest } from "#shared/sentry-breadcrumbs.ts";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";

type InitOptions = {
  dsn: string;
  release: string | undefined;
};

const fetchBody = (body: string | Uint8Array): BodyInit => body.slice();

/** Send envelopes while the SDK's public transport keeps buffering and limits. */
const makeFetchTransport: ConstructorParameters<
  typeof DenoClient
>[0]["transport"] = (options) =>
  createTransport(options, async (request) => {
    countExternalSubrequest("Sentry transport");
    const response = await fetch(options.url, {
      body: fetchBody(request.body),
      headers: new Headers(options.headers),
      method: "POST",
      referrerPolicy: "strict-origin",
    });
    return {
      headers: {
        "retry-after": response.headers.get("retry-after"),
        "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
      },
      statusCode: response.status,
    };
  });

/**
 * Constructing `DenoClient` directly adds no integrations at all, so the two
 * that put information into a report are named here. Both are pure event
 * shaping: they read the event and the console, never Deno globals or source
 * files on disk, which is all the edge runtime supports.
 *
 * `linkedErrors` walks an error's `cause` chain. Without it a report names the
 * wrapper — "libsql execute failed" — and drops the failure underneath it.
 *
 * `breadcrumbs` keeps the console lines printed before the error, which carry
 * the request id, so a report leads back to its own log.
 *
 * Deliberately absent: `dedupe` drops an error that repeats, and two requests
 * hitting one bug are two real occurrences, not a duplicate. `fetch`
 * breadcrumbs are off because an outbound URL can carry a session id.
 */
const eventShapingIntegrations = [
  breadcrumbsIntegration({ console: true, fetch: false, sentry: false }),
  linkedErrorsIntegration(),
];

/**
 * Drop the console lines that belong to other requests. The SDK collects them
 * onto one shared scope, so without this a report on a busy isolate carries
 * whatever ran beside it. `requestId` is the tag the reporter sets.
 */
const keepOwnBreadcrumbs = (event: ErrorEvent): ErrorEvent => {
  // A tag is typed as any primitive, but the reporter only ever sets strings.
  // Anything else leaves no id to match on, so every line is kept.
  const requestId = event.tags?.requestId;
  return event.breadcrumbs === undefined
    ? event
    : {
        ...event,
        breadcrumbs: linesForRequest(
          typeof requestId === "string" ? requestId : undefined,
          event.breadcrumbs,
        ),
      };
};

const init = (options: InitOptions): DenoClient => {
  const client = new DenoClient({
    ...options,
    beforeSend: keepOwnBreadcrumbs,
    integrations: eventShapingIntegrations,
    stackParser: createStackParser(nodeStackLineParser()),
    tracesSampleRate: 0,
    transport: makeFetchTransport,
  });
  getCurrentScope().setClient(client);
  client.init();
  return client;
};

/** One classified server error, in the shape the SDK wants it. */
export type ServerReport = {
  /** The original exception when there is one. Carries the stack trace. */
  error: unknown;
  /** Safe extra detail, shown beside the report. */
  extra: Record<string, string>;
  /** What to group the report under. Empty leaves the SDK's own grouping. */
  fingerprint: string[];
  /** Used only when no exception is attached. */
  message: string;
  tags: Record<string, string>;
  /** The route the report happened on, or undefined outside a request. */
  transactionName: string | undefined;
};

/**
 * Capture one report with its whole scope set, and return its event id. Keeps
 * every Scope call in this adapter, so the reporter above stays SDK-free.
 */
const captureReport = (report: ServerReport): string => {
  const applyScope = (scope: Scope): Scope => {
    scope.setLevel("error");
    scope.setTags(report.tags);
    scope.setExtras(report.extra);
    scope.setTransactionName(report.transactionName);
    if (report.fingerprint.length > 0) scope.setFingerprint(report.fingerprint);
    return scope;
  };
  return report.error === undefined
    ? captureMessage(report.message, applyScope)
    : captureException(report.error, applyScope);
};

export const sentrySdk = {
  captureException,
  captureMessage,
  captureReport,
  flush,
  getCurrentScope,
  getGlobalScope,
  getIsolationScope,
  init,
  isInitialized,
};
