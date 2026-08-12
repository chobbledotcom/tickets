/* jscpd:ignore-start */
import { isNotNullish } from "#fp";
import { errorMessage } from "#shared/error-message.ts";
import { type FetchResult, fetchText } from "#shared/fetch.ts";
import type { ProviderUnavailableReason } from "#shared/payment/provider-read.ts";
/* jscpd:ignore-end */

/** Square API version for all requests. */
export const SQUARE_API_VERSION = "2025-01-23";

/** Optional method and JSON body for one Square REST call. */
export type SquareRequestOptions = { method?: string; body?: unknown };

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
    readonly responseBody: string,
  ) {
    super(`Status code: ${statusCode} Body: ${responseBody}`);
  }
}

/** Square could not be reached. */
export class SquareConnectionError extends Error {
  constructor(
    readonly reason: Extract<
      ProviderUnavailableReason,
      "network_error" | "timeout"
    >,
    detail: string,
  ) {
    super(detail);
  }
}

/** Square returned a success response that was not valid JSON. */
export class SquareProtocolError extends Error {}

const squareConnectionReason = (
  error: unknown,
): SquareConnectionError["reason"] | undefined =>
  error instanceof DOMException &&
  (error.name === "AbortError" || error.name === "TimeoutError")
    ? "timeout"
    : error instanceof TypeError
      ? "network_error"
      : undefined;

const fetchSquareResponse = async (
  url: string,
  init: ReturnType<typeof squareRequestInit>,
): Promise<FetchResult> => {
  try {
    return await fetchText(url, init);
  } catch (error) {
    const reason = squareConnectionReason(error);
    if (!reason) throw error;
    throw new SquareConnectionError(reason, errorMessage(error));
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
    throw new SquareApiError(response.status, response.text);
  }
  try {
    return JSON.parse(response.text);
  } catch (error) {
    throw new SquareProtocolError(errorMessage(error));
  }
};
