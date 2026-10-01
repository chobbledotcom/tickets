/* jscpd:ignore-start */
import * as v from "valibot";
import { isNotNullish } from "#fp";
import {
  type ProviderRequest,
  providerCaller,
} from "#payment/provider-fetch.ts";
import {
  providerDetail,
  type RejectedBuyerField,
} from "#payment/transport-error.ts";
import type { FetchResult } from "#shared/fetch.ts";
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

/** One Square REST call: where it goes, and how it asks. */
export type SquareRequest = {
  baseUrl: string;
  options?: SquareRequestOptions;
  path: string;
  token: string;
};

/** The URL and request init for one Square REST call, bound together. */
const squareRequestFor = ({
  baseUrl,
  options,
  path,
  token,
}: SquareRequest): [string, ProviderRequest] => [
  `${baseUrl}${path}`,
  squareRequestInit(token, options),
];

/** Make one authenticated request to the Square REST API. */
export const squareFetch = (request: SquareRequest): Promise<unknown> =>
  squareCaller.json(...squareRequestFor(request));

/** Make one authenticated request and hand back the whole answer — status
 * and body included, refused or not. The link-end classifier reads Square's
 * refusal words itself, so it must see the answer Square actually gave. */
export const squareFetchAnswer = (
  request: SquareRequest,
): Promise<FetchResult> => squareCaller.answer(...squareRequestFor(request));
