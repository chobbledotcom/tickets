/**
 * One factory for every outbound JSON API client in the app.
 *
 * Each module that talks to an external API used to re-implement the same
 * five steps. The steps are the base URL, the auth header, the status check,
 * the error parse, and the JSON read. This factory owns all five. A client
 * supplies the base URL and its auth headers. A request supplies a valibot
 * schema for the body it expects back. The shared machinery validates the
 * answer into a `Result`.
 */

import { type GenericSchema, safeParse } from "valibot";
import { type FetchResult, fetchText, parseApiError } from "#shared/fetch.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** How a client fetches one URL. The default is `fetchText`. A client that
 * answers from a site-build dry run, or follows safe redirects, substitutes
 * its own step. */
export type ApiClientFetch = (
  url: string,
  init: RequestInit,
) => Promise<FetchResult>;

/** The shared request steps, configured for one API. */
export type ApiClientConfig<E = string> = {
  /** The URL every path is joined onto. */
  baseUrl: string;
  /** The auth headers every request carries. The caller's own headers win. */
  headers: () => Record<string, string>;
  /** The error-body keys the shared status-and-message parse tries, in order.
   * The keys are ignored when `parseError` is given. */
  errorKeys?: string[];
  /** How a non-ok answer becomes the error branch. Defaults to the shared
   * status-and-message parse. */
  parseError?: (response: FetchResult, label: string) => E;
  /** How a body that is not readable JSON, or fails its schema, becomes the
   * error branch. Defaults to the shared "returned an invalid response"
   * message. */
  unreadableError?: (label: string) => E;
  /** The fetch step. Defaults to `fetchText`. */
  fetchImpl?: ApiClientFetch;
};

/** One status-checked call: a path, an init, and a label for failures. The
 * shared shape of `fetch` (whole answer) and `send` (no body read). */
export type CheckedRequest<E, T> = (
  path: string,
  init: RequestInit,
  label: string,
) => Promise<Result<T, E>>;

/** One configured client: the shared request, send, and raw steps. */
export type ApiClient<E = string> = {
  /** The full URL for a path. */
  url: (path: string) => string;
  /** Fetch one URL with the client's base and headers, no status handling. */
  raw: (path: string, init?: RequestInit) => Promise<FetchResult>;
  /** Ask once, check the status, and hand back the whole answer. A call that
   * reads its own body (a raw text token, a non-JSON answer) starts here. */
  fetch: CheckedRequest<E, FetchResult>;
  /** Ask once, check the status, and read no body. */
  send: CheckedRequest<E, void>;
  /** Ask once, check the status, and validate the JSON body through a schema. */
  request: <T>(
    path: string,
    init: RequestInit,
    schema: GenericSchema<unknown, T>,
    label: string,
  ) => Promise<Result<T, E>>;
};

/** The default error parse: the shared status-and-message text. */
const defaultParseError = (
  response: FetchResult,
  label: string,
  errorKeys: string[] | undefined,
): string => parseApiError(response, label, errorKeys).error;

/** A body the client cannot read: a torn JSON document, or a valid document
 * that fails its schema. Named after the label the request carried, the way
 * every API client in the app names its failures. */
const defaultUnreadableError = (label: string): string =>
  `${label} returned an invalid response`;

/**
 * Build one API client. The returned methods handle the base URL, the auth
 * headers, the status check, the error parse, and the JSON parse. A request
 * only supplies the path, the init, the schema, and a label for failures.
 */
export const defineApiClient = <E = string>(
  config: ApiClientConfig<E>,
): ApiClient<E> => {
  const parseError: (response: FetchResult, label: string) => E =
    config.parseError ??
    ((response, label) =>
      defaultParseError(response, label, config.errorKeys) as E);
  const unreadableError: (label: string) => E =
    config.unreadableError ?? ((label) => defaultUnreadableError(label) as E);
  const fetchImpl = config.fetchImpl ?? fetchText;

  const url = (path: string): string => `${config.baseUrl}${path}`;

  const raw = (path: string, init: RequestInit = {}): Promise<FetchResult> =>
    fetchImpl(url(path), {
      ...init,
      headers: {
        ...config.headers(),
        ...(init.headers as Record<string, string> | undefined),
      },
    });

  /** One status-checked call: run the request, then either hand the answer to
   * `onOk` or report the parsed error. */
  const check = async <T>(
    path: string,
    init: RequestInit,
    label: string,
    onOk: (response: FetchResult) => Result<T, E>,
  ): Promise<Result<T, E>> => {
    const response = await raw(path, init);
    return response.ok
      ? onOk(response)
      : errorResult(parseError(response, label));
  };

  const client: ApiClient<E> = {
    fetch: (path, init, label) => check(path, init, label, okResult),
    raw,
    request: (path, init, schema, label) =>
      check(path, init, label, (response) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(response.text);
        } catch {
          return errorResult(unreadableError(label));
        }
        const validated = safeParse(schema, parsed);
        return validated.success
          ? okResult(validated.output)
          : errorResult(unreadableError(label));
      }),
    send: (path, init, label) =>
      check(path, init, label, () => okResult(undefined)),
    url,
  };
  return client;
};
