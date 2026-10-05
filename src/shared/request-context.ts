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

import type { QueryLogState } from "#db/query-log.ts";
import type { AuditState } from "#db/settings-audit.ts";
import type { FlashStore } from "#shared/flash-context.ts";
import type { SavedFormState } from "#shared/forms/saved-data.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { redactPath } from "#shared/redact-path.ts";
import { createScope, type PromiseTask } from "#shared/request-scoped.ts";
import type { SessionState } from "#shared/session-context.ts";
import type { AdminFooterState } from "#templates/admin/footer.tsx";

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
  clientIp: string;
  iframe: boolean;
  locale: string;
  requestId: string;
  trace: RequestTrace;
  /** Slots the per-request caches keep their data in
   * (src/shared/request-cache.ts). */
  cache: Map<symbol, unknown>;
  /** Query recording and guard counters, allocated on the request's first
   * database call (src/shared/db/query-log.ts). */
  queryLog?: QueryLogState;
  /** Settings-audit bookkeeping, allocated only while the audit is enabled
   * (src/shared/db/settings-audit.ts). */
  settingsAudit?: AuditState;
  /** The flash message, allocated when middleware populates it
   * (src/shared/flash-context.ts). */
  flash?: FlashStore;
  /** Session memoisation, allocated when the session resolves
   * (src/shared/session-context.ts). */
  session?: SessionState;
  /** The most recently minted CSRF token, for synchronous JSX rendering
   * (src/shared/csrf.ts). */
  csrfToken?: string;
  /** The stashed submitted form for re-filling a redirected form
   * (src/shared/forms/saved-data.ts). */
  savedForm?: SavedFormState;
  /** Set while an admin page renders, consumed by the Layout footer
   * (src/ui/templates/admin/footer.tsx). */
  adminFooter?: AdminFooterState;
};

const requestScope = createScope<RequestStore>();

/** The facts the request boundary resolved before the context began. */
export type RequestFacts = { clientIp: string; locale: string };

/**
 * Run `fn` inside one request context. The store dies when `fn`'s promise
 * settles (the request-scoped leak trap), so a later, unrelated piece of work
 * always reads as outside any request. `locale` is parsed at the composition
 * site, so this module stays free of the i18n import (i18n reads this module,
 * not the other way round).
 */
export const runWithRequestContext = <T>(
  request: Request,
  facts: RequestFacts,
  fn: PromiseTask<T>,
): Promise<T> => {
  const url = new URL(request.url);
  return requestScope.run(
    {
      cache: new Map(),
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

/** The current request's store, or undefined outside one. */
export const currentRequestStore = (): RequestStore | undefined =>
  requestScope.current();

/** A lazily-initialised slot on the request store, owned by one module. */
export type RequestSlot<S> = {
  fresh: () => S;
  read: (store: RequestStore) => S | undefined;
  write: (store: RequestStore, value: S) => void;
};

/** Get or allocate one slot on the current request's store. Undefined
 * outside a request. */
export const requestSlot = <S>(slot: RequestSlot<S>): S | undefined => {
  const store = currentRequestStore();
  if (!store) return;
  const existing = slot.read(store);
  // Any allocated slot counts, including falsy values such as 0: the slot
  // exists, and re-running `fresh()` throws the stored value away.
  if (existing !== undefined) return existing;
  const value = slot.fresh();
  slot.write(store, value);
  return value;
};

/** Apply `use` to one slot's state, allocating it on first use. No-op
 * outside a request. */
export const withRequestSlot = <S>(
  slot: RequestSlot<S>,
  use: (state: S) => void,
): void => {
  const state = requestSlot(slot);
  if (state !== undefined) use(state);
};

/** The current request's locale, or "en" outside a request. */
/** Generate a 4-char lowercase hex string */
const generateRequestId = (): string => {
  const buf = crypto.getRandomValues(new Uint8Array(2));
  return new DataView(buf.buffer).getUint16(0).toString(16).padStart(4, "0");
};

/** The current request's locale, or "en" outside a request. */
export const getLocale = (): string => currentRequestStore()?.locale ?? "en";

/** The current request's client IP, or "direct" when not in a request scope. */
export const getRequestClientIp = (): string =>
  currentRequestStore()?.clientIp ?? "direct";

/** The current request's log-correlation id, or "" outside a request. */
export const getRequestId = (): string =>
  currentRequestStore()?.requestId ?? "";

/** The request being served, or null when nothing is being served. */
export const getRequestTrace = (): RequestTrace | null =>
  currentRequestStore()?.trace ?? null;

/** Get the current request's iframe mode */
export const getIframeMode = (): boolean =>
  currentRequestStore()?.iframe ?? false;

/** Detect iframe mode from a request URL and store it for the current request.
 * A no-op outside a request, so a direct render cannot set the ambient mode. */
export const detectIframeMode = (url: URL): void => {
  const store = currentRequestStore();
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
