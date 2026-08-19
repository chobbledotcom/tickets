import * as v from "valibot";
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-timeout.ts";
import {
  isAbortOrTimeoutError,
  isTimeoutError,
  namedError,
} from "#shared/named-error.ts";
import { delay } from "#shared/now.ts";
import { countExternalSubrequest } from "#shared/subrequest-budget.ts";
import { encodeStripeForm, type StripeFormValue } from "./form.ts";
import { parseStripeErrorBody } from "./schemas.ts";

export const STRIPE_API_VERSION = "2026-04-22.dahlia";
export const STRIPE_MAX_NETWORK_RETRIES = 2;

const STRIPE_API_URL = "https://api.stripe.com";
const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 5_000;
const MAX_RETRY_AFTER_SECONDS = 60;

type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
type StripeParams = Readonly<Record<string, StripeFormValue>>;
type Method = "DELETE" | "GET" | "POST";
type ResponseSchema<T> = v.BaseSchema<unknown, T, v.BaseIssue<unknown>>;

/**
 * Per-request options. `idempotencyKey` overrides the default per-POST retry
 * key so a caller can supply the durable refund generation's stable key across
 * process retries (see `refundIdempotencyKey` in
 * `#shared/payment-idempotency.ts`). `maxNetworkRetries` narrows one bounded
 * workflow without weakening retries for unrelated Stripe calls.
 */
export interface StripeRequestOptions {
  idempotencyKey?: string | undefined;
  maxNetworkRetries?: 0 | undefined;
}

export interface StripeClientConfig {
  apiBase?: string;
  fetch?: Fetch;
  maxNetworkRetries?: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeout?: number;
}

interface RequestConfig {
  apiBase: string;
  fetch: Fetch;
  maxNetworkRetries: number;
  random: () => number;
  secretKey: string;
  sleep: (milliseconds: number) => Promise<void>;
  timeout: number;
}

export class StripeApiError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly statusCode: number;
  readonly type: string | undefined;

  constructor(
    message: string,
    fields: {
      code: string | undefined;
      requestId: string | undefined;
      statusCode: number;
      type: string | undefined;
    },
  ) {
    super(message);
    this.name = "StripeApiError";
    this.code = fields.code;
    this.requestId = fields.requestId;
    this.statusCode = fields.statusCode;
    this.type = fields.type;
  }
}

export type StripeConnectionFailure = "network_error" | "timeout";

export class StripeConnectionError extends namedError("StripeConnectionError") {
  readonly reason: StripeConnectionFailure;

  constructor(reason: StripeConnectionFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

export class StripeProtocolError extends namedError("StripeProtocolError") {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

class StripeBodyReadError extends Error {
  readonly source: unknown;

  constructor(source: unknown) {
    super();
    this.source = source;
  }
}

const retryDelay = (
  retry: number,
  retryAfter: string | null,
  random: () => number,
): number => {
  const jittered = INITIAL_RETRY_MS * 2 ** (retry - 1) * 0.5 * (1 + random());
  const base = Math.min(MAX_RETRY_MS, Math.max(INITIAL_RETRY_MS, jittered));
  if (retryAfter === null) return base;
  const retryAfterSeconds = Number(retryAfter);
  return Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS
    ? Math.max(base, retryAfterSeconds * 1000)
    : base;
};

const shouldRetry = (response: Response): boolean => {
  const requested = response.headers.get("stripe-should-retry");
  if (requested === "false") return false;
  if (requested === "true") return true;
  return response.status === 409 || response.status >= 500;
};

/**
 * Stripe returns HTTP 429 with `error.code === "lock_timeout"` when two
 * concurrent requests contend on the same resource (e.g. a refund racing a
 * webhook). Stripe's own SDK and the rate-limits docs both treat these as
 * retryable. Without a retry, replacing stripe-node can make a retryable
 * refund or PaymentIntent lookup fail immediately instead of using the
 * configured retry budget. The rate-limit 429 (no lock_timeout) is NOT
 * retried here — Stripe marks those with `stripe-should-retry` when it wants
 * a retry, otherwise they should surface immediately. The clone keeps the
 * original body readable for the error path if we do not retry.
 *
 * https://docs.stripe.com/rate-limits#object-lock-timeouts
 */
const isLockTimeoutResponse = async (response: Response): Promise<boolean> => {
  if (response.status !== 429) return false;
  try {
    const body = (await response.clone().json()) as {
      error?: { code?: unknown; type?: unknown };
    };
    return (
      body?.error?.code === "lock_timeout" ||
      body?.error?.type === "lock_timeout"
    );
  } catch {
    return false;
  }
};

const connectionError = (
  error: unknown,
  retry: number,
  timeout: number,
): StripeConnectionError => {
  const timedOut = isTimeoutError(error);
  return new StripeConnectionError(
    timedOut ? "timeout" : "network_error",
    timedOut
      ? `Request aborted due to timeout being reached (${timeout}ms)`
      : `An error occurred with our connection to Stripe. Request was retried ${retry} times.`,
  );
};

const retriesRemain = (retry: number, maximum: number): boolean =>
  retry < maximum;

const isTransportFailure = (error: unknown): boolean =>
  error instanceof TypeError || isAbortOrTimeoutError(error);

const headerOrUndefined = (
  headers: Headers,
  name: string,
): string | undefined => {
  const value = headers.get(name);
  return value === null ? undefined : value;
};

const responseError = (
  response: Response,
  message: string,
  code: string | undefined,
  type: string | undefined,
): StripeApiError =>
  new StripeApiError(message, {
    code,
    requestId: headerOrUndefined(response.headers, "request-id"),
    statusCode: response.status,
    type,
  });

const responseText = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch (error) {
    throw new StripeBodyReadError(error);
  }
};

const stripeError = async (response: Response): Promise<StripeApiError> => {
  const text = await responseText(response);
  let parsed: ReturnType<typeof parseStripeErrorBody>;
  try {
    parsed = parseStripeErrorBody(text);
  } catch (error) {
    throw new StripeProtocolError(
      error instanceof SyntaxError
        ? "Invalid JSON received from the Stripe API"
        : "Invalid response received from the Stripe API",
      response.status,
    );
  }
  return responseError(
    response,
    parsed.error.message,
    parsed.error.code,
    parsed.error.type,
  );
};

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation only frees resources; its failure must not hide the retry.
  }
};

const parseResponse = async <T>(
  response: Response,
  schema: ResponseSchema<T>,
): Promise<T> => {
  if (!response.ok) throw await stripeError(response);
  const text = await responseText(response);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new StripeProtocolError("Invalid JSON received from the Stripe API");
  }
  try {
    return v.parse(schema, body);
  } catch {
    throw new StripeProtocolError(
      "Invalid response received from the Stripe API",
    );
  }
};

const fullConfig = (
  secretKey: string,
  {
    apiBase = STRIPE_API_URL,
    fetch: fetchImpl = (input, init) => fetch(input, init),
    maxNetworkRetries = STRIPE_MAX_NETWORK_RETRIES,
    random = Math.random,
    sleep: sleepImpl = delay,
    timeout = PROVIDER_TIMEOUT_MS,
  }: StripeClientConfig,
): RequestConfig => ({
  apiBase,
  fetch: fetchImpl,
  maxNetworkRetries,
  random,
  secretKey,
  sleep: sleepImpl,
  timeout,
});

/** Build the versioned Stripe request transport with bounded retries. */
export const createStripeRequest = (
  secretKey: string,
  clientConfig: StripeClientConfig = {},
) => {
  const config = fullConfig(secretKey, clientConfig);
  return async <T>(
    method: Method,
    path: string,
    params: StripeParams,
    schema: ResponseSchema<T>,
    options: StripeRequestOptions = {},
  ): Promise<T> => {
    const maxNetworkRetries =
      options.maxNetworkRetries ?? config.maxNetworkRetries;
    const encoded = encodeStripeForm(params);
    const url = `${config.apiBase}${path}${
      method === "GET" && encoded ? `?${encoded}` : ""
    }`;
    const idempotencyKey =
      options.idempotencyKey ??
      (method === "POST" && maxNetworkRetries > 0
        ? `tickets-stripe-retry-${crypto.randomUUID()}`
        : undefined);
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    });
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

    async function retryConnection(error: unknown, retry: number): Promise<T> {
      if (!isTransportFailure(error)) throw error;
      if (!retriesRemain(retry, maxNetworkRetries)) {
        throw connectionError(error, retry, config.timeout);
      }
      await config.sleep(retryDelay(retry, null, config.random));
      return attempt(retry + 1);
    }

    async function finish(response: Response, retry: number): Promise<T> {
      try {
        return await parseResponse(response, schema);
      } catch (error) {
        if (error instanceof StripeBodyReadError) {
          return retryConnection(error.source, retry);
        }
        throw error;
      }
    }

    async function attempt(retry: number): Promise<T> {
      let response: Response;
      countExternalSubrequest("Stripe API request");
      try {
        response = await config.fetch(url, {
          ...(method === "POST" ? { body: encoded } : {}),
          headers,
          method,
          signal: AbortSignal.timeout(config.timeout),
        });
      } catch (error) {
        return retryConnection(error, retry);
      }
      if (
        retriesRemain(retry, maxNetworkRetries) &&
        (shouldRetry(response) || (await isLockTimeoutResponse(response)))
      ) {
        await cancelResponseBody(response);
        await config.sleep(
          retryDelay(retry, response.headers.get("retry-after"), config.random),
        );
        return attempt(retry + 1);
      }
      return finish(response, retry);
    }

    return attempt(0);
  };
};
