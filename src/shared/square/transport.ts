/* jscpd:ignore-start */
import * as v from "valibot";
import { isNotNullish } from "#fp";
import { providerCaller } from "#payment/provider-fetch.ts";
import {
  providerDetail,
  type RejectedBuyerField,
} from "#payment/transport-error.ts";
/* jscpd:ignore-end */

/** Square API version for all requests. */
export const SQUARE_API_VERSION = "2025-01-23";

/** Optional method and JSON body for one Square REST call. */
export type SquareRequestOptions = { method?: string; body?: unknown };

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
): RejectedBuyerField | null =>
  field === "pre_populated_data.buyer_email"
    ? "email"
    : field === "pre_populated_data.buyer_phone_number"
      ? "phone"
      : null;

/** Keep only the closed validation fact checkout needs from an error body. */
const readInvalidField = (responseBody: string): RejectedBuyerField | null => {
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

/** Square names the buyer field it rejected in the answer body, and that is
 *  the one failure the buyer can act on, so its detail reads that body. */
const squareCaller = providerCaller((body) =>
  providerDetail.square(readInvalidField(body)),
);

/** Make one authenticated request to the Square REST API. */
export const squareFetch = (
  token: string,
  baseUrl: string,
  path: string,
  options?: SquareRequestOptions,
): Promise<unknown> =>
  squareCaller.json(`${baseUrl}${path}`, squareRequestInit(token, options));
