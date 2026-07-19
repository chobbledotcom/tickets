import * as v from "valibot";
import { delay } from "#shared/now.ts";
import { encodeStripeForm, type StripeFormValue } from "./form.ts";
import {
  parseStripeErrorBody,
  type StripeBalance,
  StripeBalanceSchema,
  type StripeCheckoutSession,
  StripeCheckoutSessionSchema,
  type StripePaymentIntent,
  StripePaymentIntentSchema,
  type StripeRefund,
  StripeRefundSchema,
  type StripeWebhookEndpoint,
  StripeWebhookEndpointListSchema,
  type StripeWebhookEndpointWrite,
  StripeWebhookEndpointWriteSchema,
} from "./schemas.ts";

export const STRIPE_API_VERSION = "2026-04-22.dahlia";
export const STRIPE_TIMEOUT_MS = 20_000;
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

export class StripeConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeConnectionError";
  }
}

export interface StripeClient {
  balance: { retrieve: () => Promise<StripeBalance> };
  checkout: {
    sessions: {
      create: (params: StripeParams) => Promise<StripeCheckoutSession>;
      retrieve: (id: string) => Promise<StripeCheckoutSession>;
    };
  };
  paymentIntents: {
    retrieve: (
      id: string,
      params: StripeParams,
    ) => Promise<StripePaymentIntent>;
  };
  refunds: {
    create: (params: StripeParams) => Promise<StripeRefund>;
  };
  webhookEndpoints: {
    create: (params: StripeParams) => Promise<StripeWebhookEndpointWrite>;
    del: (id: string) => Promise<StripeWebhookEndpointWrite>;
    list: (params: StripeParams) => Promise<{ data: StripeWebhookEndpoint[] }>;
  };
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

const retryDelay = (
  retry: number,
  retryAfter: string | null,
  random: () => number,
): number => {
  const jittered =
    Math.min(INITIAL_RETRY_MS * 2 ** retry, MAX_RETRY_MS) *
    0.5 *
    (1 + random());
  const base = Math.max(INITIAL_RETRY_MS, jittered);
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

const connectionError = (
  error: unknown,
  retry: number,
  timeout: number,
): StripeConnectionError =>
  new StripeConnectionError(
    error instanceof DOMException && error.name === "TimeoutError"
      ? `Request aborted due to timeout being reached (${timeout}ms)`
      : `An error occurred with our connection to Stripe. Request was retried ${retry} times.`,
  );

const retriesRemain = (retry: number, maximum: number): boolean =>
  retry < maximum;

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

const stripeError = async (response: Response): Promise<StripeApiError> => {
  const text = await response.text();
  let parsed: ReturnType<typeof parseStripeErrorBody>;
  try {
    parsed = parseStripeErrorBody(text);
  } catch {
    throw responseError(
      response,
      "Invalid JSON received from the Stripe API",
      undefined,
      "StripeAPIError",
    );
  }
  return responseError(
    response,
    parsed.error.message,
    parsed.error.code,
    parsed.error.type,
  );
};

const parseResponse = async <T>(
  response: Response,
  schema: ResponseSchema<T>,
): Promise<T> => {
  if (!response.ok) throw await stripeError(response);
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw responseError(
      response,
      "Invalid JSON received from the Stripe API",
      undefined,
      undefined,
    );
  }
  return v.parse(schema, body);
};

const createRequest =
  (config: RequestConfig) =>
  async <T>(
    method: Method,
    path: string,
    params: StripeParams,
    schema: ResponseSchema<T>,
  ): Promise<T> => {
    const encoded = encodeStripeForm(params);
    const url = `${config.apiBase}${path}${method === "GET" && encoded ? `?${encoded}` : ""}`;
    const idempotencyKey =
      method === "POST" && config.maxNetworkRetries > 0
        ? `tickets-stripe-retry-${crypto.randomUUID()}`
        : undefined;
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    });
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

    const attempt = async (retry: number): Promise<T> => {
      let response: Response;
      try {
        response = await config.fetch(url, {
          ...(method === "POST" ? { body: encoded } : {}),
          headers,
          method,
          signal: AbortSignal.timeout(config.timeout),
        });
      } catch (error) {
        if (!retriesRemain(retry, config.maxNetworkRetries)) {
          throw connectionError(error, retry, config.timeout);
        }
        await config.sleep(retryDelay(retry, null, config.random));
        return attempt(retry + 1);
      }
      if (
        retriesRemain(retry, config.maxNetworkRetries) &&
        shouldRetry(response)
      ) {
        await response.body?.cancel();
        await config.sleep(
          retryDelay(retry, response.headers.get("retry-after"), config.random),
        );
        return attempt(retry + 1);
      }
      return parseResponse(response, schema);
    };
    return attempt(0);
  };

/** Build the small Stripe API surface used by ticket payments. */
export const createStripeClient = (
  secretKey: string,
  {
    apiBase = STRIPE_API_URL,
    fetch: fetchImpl = fetch,
    maxNetworkRetries = STRIPE_MAX_NETWORK_RETRIES,
    random = Math.random,
    sleep: sleepImpl = delay,
    timeout = STRIPE_TIMEOUT_MS,
  }: StripeClientConfig = {},
): StripeClient => {
  const config: RequestConfig = {
    apiBase,
    fetch: fetchImpl,
    maxNetworkRetries,
    random,
    secretKey,
    sleep: sleepImpl,
    timeout,
  };
  const call = createRequest(config);
  const idPath = (resource: string, id: string): string =>
    `/v1/${resource}/${encodeURIComponent(id)}`;

  return {
    balance: {
      retrieve: () => call("GET", "/v1/balance", {}, StripeBalanceSchema),
    },
    checkout: {
      sessions: {
        create: (params) =>
          call(
            "POST",
            "/v1/checkout/sessions",
            params,
            StripeCheckoutSessionSchema,
          ),
        retrieve: (id) =>
          call(
            "GET",
            idPath("checkout/sessions", id),
            {},
            StripeCheckoutSessionSchema,
          ),
      },
    },
    paymentIntents: {
      retrieve: (id, params) =>
        call(
          "GET",
          idPath("payment_intents", id),
          params,
          StripePaymentIntentSchema,
        ),
    },
    refunds: {
      create: (params) =>
        call("POST", "/v1/refunds", params, StripeRefundSchema),
    },
    webhookEndpoints: {
      create: (params) =>
        call(
          "POST",
          "/v1/webhook_endpoints",
          params,
          StripeWebhookEndpointWriteSchema,
        ),
      del: (id) =>
        call(
          "DELETE",
          idPath("webhook_endpoints", id),
          {},
          StripeWebhookEndpointWriteSchema,
        ),
      list: (params) =>
        call(
          "GET",
          "/v1/webhook_endpoints",
          params,
          StripeWebhookEndpointListSchema,
        ),
    },
  };
};
