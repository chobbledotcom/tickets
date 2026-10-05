/**
 * The one request context. One AsyncLocalStorage frame carries the facts a
 * request sets once at the boundary and reads anywhere below it (#2280).
 *
 * Pending work (src/shared/pending-work.ts) and message groups
 * (src/shared/i18n.ts) keep their own scopes. The queue must outlive the
 * response. Concurrent route re-scopes cannot share one store field
 * (test/shared/i18n/loading.test.ts).
 *
 * Accessors fall back to the ambient default outside a request. Mutators
 * write only a live store.
 */

import { runWithPendingWork } from "#shared/pending-work.ts";
import { redactPath } from "#shared/redact-path.ts";
import { createScope, type PromiseTask } from "#shared/request-scoped.ts";

/** The safe-to-report identity of one request. */
export type RequestTrace = {
  /** The public host the visitor asked for. */
  host: string;
  method: string;
  /** The path with its secrets removed. Names the route, never the person. */
  route: string;
};

/** The facts one request carries. Minted fresh by runWithRequestContext. */
export type RequestStore = {
  /** The locale the request's Accept-Language header negotiated. */
  locale: string;
  /** The client IP resolved at the boundary, or "direct" for in-process calls. */
  clientIp: string;
  /** The 4-character hex id every log line of this request carries. */
  requestId: string;
  trace: RequestTrace;
  /** Set from the request URL early in the pipeline, read by renderers. */
  iframe: boolean;
};

const requestScope = createScope<RequestStore>();

/**
 * Run `fn` inside one request context. The store dies when `fn`'s promise
 * settles (the request-scoped leak trap), so a later, unrelated piece of work
 * always reads as outside any request. `locale` is parsed at the composition
 * site, so this module stays free of the i18n import (i18n reads this module,
 * not the other way round).
 */
/** The facts the request boundary resolved before the context began. */
export type RequestFacts = { clientIp: string; locale: string };

export const runWithRequestContext = <T>(
  request: Request,
  facts: RequestFacts,
  fn: PromiseTask<T>,
): Promise<T> => {
  const url = new URL(request.url);
  return requestScope.run(
    {
      clientIp: facts.clientIp,
      iframe: url.searchParams.get("iframe") === "true",
      locale: facts.locale,
      requestId: generateRequestId(),
      trace: {
        host: url.host,
        method: request.method,
        route: redactPath(url.pathname),
      },
    },
    () => runWithPendingWork(fn),
  );
};

/** The live request's store, or undefined outside one. */
const current = (): RequestStore | undefined => requestScope.current();

/** Generate a 4-char lowercase hex string */
const generateRequestId = (): string => {
  const buf = crypto.getRandomValues(new Uint8Array(2));
  return new DataView(buf.buffer).getUint16(0).toString(16).padStart(4, "0");
};

/** The current request's locale, or "en" outside a request. */
export const getLocale = (): string => current()?.locale ?? "en";

/** The current request's client IP, or "direct" when not in a request scope. */
export const getRequestClientIp = (): string => current()?.clientIp ?? "direct";

/** The current request's log-correlation id, or "" outside a request. */
export const getRequestId = (): string => current()?.requestId ?? "";

/** The request being served, or null when nothing is being served. */
export const getRequestTrace = (): RequestTrace | null =>
  current()?.trace ?? null;

/** Get the current request's iframe mode */
export const getIframeMode = (): boolean => current()?.iframe ?? false;

/** Detect iframe mode from a request URL and store it for the current request.
 * A no-op outside a request, so a direct render cannot set the ambient mode. */
export const detectIframeMode = (url: URL): void => {
  const store = current();
  if (store) store.iframe = url.searchParams.get("iframe") === "true";
};

/** Append iframe=true query param to a URL when in iframe mode */
export const appendIframeParam = (url: string): string => {
  if (!getIframeMode()) return url;
  if (!URL.canParse(url, "http://localhost")) {
    throw new TypeError("Invalid iframe redirect URL");
  }

  const parsed = new URL(url, "http://localhost");
  parsed.searchParams.set("iframe", "true");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
};
