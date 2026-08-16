/* jscpd:ignore-start */
import * as v from "valibot";
import { isNotNullish } from "#fp";
import { type FetchResult, fetchText } from "#shared/fetch.ts";
import { isAbortOrTimeoutError } from "#shared/named-error.ts";
import type { ProviderUnavailableReason } from "#shared/payment/provider-read.ts";
import { PROVIDER_TIMEOUT_MS } from "#shared/payment/provider-timeout.ts";
/* jscpd:ignore-end */

/** Square API version for all requests. */
export const SQUARE_API_VERSION = "2025-01-23";

/** Square transport currently makes one physical fetch per logical call. */
export const SQUARE_MAX_NETWORK_RETRIES = 0;

/** Optional method and JSON body for one Square REST call. */
export type SquareRequestOptions = { method?: string; body?: unknown };

/** A buyer field Square can reject with a message safe to show to them. */
export type SquareInvalidField = "email" | "phone";

const SquareApiErrorEntrySchema = v.object({
  category: v.string(),
  code: v.string(),
  field: v.optional(v.string()),
});

const SquareApiErrorResponseSchema = v.object({
  errors: v.array(SquareApiErrorEntrySchema),
});

const namedInvalidField = (
  field: string | undefined,
): SquareInvalidField | null =>
  field === "pre_populated_data.buyer_email"
    ? "email"
    : field === "pre_populated_data.buyer_phone_number"
      ? "phone"
      : null;

/** Keep only the closed validation fact checkout needs from an error body. */
const readInvalidField = (responseBody: string): SquareInvalidField | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(responseBody);
  } catch {
    // An error body is optional validation evidence, not application data.
    return null;
  }
  const parsed = v.safeParse(SquareApiErrorResponseSchema, raw);
  if (!parsed.success) return null;
  return (
    parsed.output.errors
      .filter(({ category }) => category === "INVALID_REQUEST_ERROR")
      .map(({ field }) => namedInvalidField(field))
      .find(isNotNullish) ?? null
  );
};

const jsonStringify = (value: unknown): string =>
  JSON.stringify(value, (_, field) =>
    typeof field === "bigint" ? Number(field) : field,
  );

/** Build the auth headers and JSON body used by Square REST calls. */
export const squareRequestInit = (
  token: string,
  options?: SquareRequestOptions,
): { headers: Record<string, string>; method: string; body?: string } => {
  const body = options?.body;
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_API_VERSION,
    },
    method: options?.method ?? "GET",
    ...(isNotNullish(body) ? { body: jsonStringify(body) } : {}),
  };
};

/** A non-successful response from Square. */
export class SquareApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly invalidField: SquareInvalidField | null = null,
  ) {
    super(`Square API request failed. Status code: ${statusCode}`);
  }
}

/** Square could not be reached. */
export class SquareConnectionError extends Error {
  constructor(
    readonly reason: Extract<
      ProviderUnavailableReason,
      "network_error" | "timeout"
    >,
  ) {
    super(
      reason === "timeout"
        ? "Square request timed out"
        : "Square connection failed",
    );
  }
}

/** Square returned a success response that was not valid JSON. */
export class SquareProtocolError extends Error {
  constructor() {
    super("Square returned an invalid response");
  }
}

const squareConnectionReason = (
  error: unknown,
): SquareConnectionError["reason"] | undefined =>
  isAbortOrTimeoutError(error)
    ? "timeout"
    : error instanceof TypeError
      ? "network_error"
      : undefined;

const fetchSquareResponse = async (
  url: string,
  init: ReturnType<typeof squareRequestInit>,
): Promise<FetchResult> => {
  try {
    return await fetchText(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = squareConnectionReason(error);
    if (!reason) throw error;
    throw new SquareConnectionError(reason);
  }
};

/** Make one authenticated request to the Square REST API. */
export const squareFetch = async (
  token: string,
  baseUrl: string,
  path: string,
  options?: SquareRequestOptions,
): Promise<unknown> => {
  const response = await fetchSquareResponse(
    `${baseUrl}${path}`,
    squareRequestInit(token, options),
  );
  if (!response.ok) {
    throw new SquareApiError(response.status, readInvalidField(response.text));
  }
  try {
    return JSON.parse(response.text);
  } catch {
    throw new SquareProtocolError();
  }
};
