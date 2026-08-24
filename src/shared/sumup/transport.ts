import { PROVIDER_TIMEOUT_MS } from "#payment/provider-timeout.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { fetchText } from "#shared/fetch.ts";
import { readJson } from "#shared/read-json.ts";

const SUMUP_API_BASE = "https://api.sumup.com";

/** SumUp transport currently makes one physical fetch per logical call. */
export const SUMUP_MAX_NETWORK_RETRIES = 0;

export type SumupTransport = {
  readCheckout(checkoutId: string): Promise<unknown>;
  readTransaction(
    merchantCode: string,
    query: { id: string },
  ): Promise<unknown>;
  refundTransaction(merchantCode: string, transactionId: string): Promise<void>;
};

const parseJson = async (text: string): Promise<unknown> => {
  const read = await readJson(() => JSON.parse(text));
  if (!read.ok) throw transportError.unusable(providerDetail.sumup());
  return read.value;
};

const sumupRequest = async (
  apiKey: string,
  path: string,
  method: "GET" | "POST",
): Promise<string> => {
  const response = await fetchText(`${SUMUP_API_BASE}${path}`, {
    headers: {
      Accept: "application/problem+json, application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw transportError.answered(providerDetail.sumup(), response.status);
  }
  return response.text;
};

/** SumUp reads and refunds whose HTTP status must survive malformed response
 * bodies. The SDK parses before exposing its Response, so a broken error body
 * otherwise erases an authoritative 404 or rejection. */
export const createSumupTransport = (apiKey: string): SumupTransport => ({
  readCheckout: async (checkoutId) =>
    await parseJson(
      await sumupRequest(
        apiKey,
        `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`,
        "GET",
      ),
    ),
  readTransaction: async (merchantCode, { id }) =>
    await parseJson(
      await sumupRequest(
        apiKey,
        `/v2.1/merchants/${encodeURIComponent(merchantCode)}/transactions?id=${encodeURIComponent(
          id,
        )}`,
        "GET",
      ),
    ),
  refundTransaction: async (merchantCode, transactionId) => {
    const body = await sumupRequest(
      apiKey,
      `/v1.0/merchants/${encodeURIComponent(merchantCode)}/payments/${encodeURIComponent(
        transactionId,
      )}/refunds`,
      "POST",
    );
    // The documented answer is empty. If SumUp adds a JSON envelope, it still
    // proves the request was accepted; an unreadable envelope proves only that
    // the POST may have landed.
    if (body !== "") await parseJson(body);
  },
});
