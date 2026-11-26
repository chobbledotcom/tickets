/**
 * Delete the Stripe webhook endpoints that a preview registered. The app
 * registers `https://<host>/payment/webhook` on the host that its owner used.
 * A preview that is deleted must not leave its endpoints behind, because a
 * Stripe account holds a limited number of them.
 */

import * as v from "valibot";
import { formatBunnyError } from "#scripts/deploy-edge-lib.ts";
import type { FetchText, FetchTextResult } from "#scripts/fetch-text.ts";
import { parseAnswer } from "#scripts/preview/answers.ts";
import { eachInOrder } from "#scripts/preview/steps.ts";
import { paymentWebhookUrl } from "#shared/payment-webhook-address.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

export type StripeIo = { fetchText: FetchText; secretKey: string };

type Endpoint = { id: string; url: string };

const ENDPOINTS_URL = "https://api.stripe.com/v1/webhook_endpoints";
const PAGE_SIZE = 100;

const EndpointPageSchema = v.object({
  data: v.array(v.object({ id: v.string(), url: v.string() })),
  has_more: v.boolean(),
});

const callStripe = (
  io: StripeIo,
  path: string,
  method: string,
): Promise<FetchTextResult> =>
  io.fetchText(`${ENDPOINTS_URL}${path}`, {
    headers: { Authorization: `Bearer ${io.secretKey}` },
    method,
  });

/** Every endpoint of the account, one page after another. */
const listEndpoints = async (
  io: StripeIo,
  after = "",
  earlier: Endpoint[] = [],
): Promise<Result<Endpoint[]>> => {
  const response = await callStripe(
    io,
    `?limit=${PAGE_SIZE}${after === "" ? "" : `&starting_after=${after}`}`,
    "GET",
  );
  const page = parseAnswer(
    response,
    "List Stripe webhooks",
    EndpointPageSchema,
  );
  if (!page.ok) return page;
  const found = [...earlier, ...page.value.data];
  const last = page.value.data.at(-1);
  return page.value.has_more && last !== undefined
    ? listEndpoints(io, last.id, found)
    : okResult(found);
};

const deleteEndpoint = async (
  io: StripeIo,
  endpoint: Endpoint,
): Promise<Result<string>> => {
  const response = await callStripe(io, `/${endpoint.id}`, "DELETE");
  // An endpoint that is already gone counts as deleted.
  return response.ok || response.status === 404
    ? okResult(`Stripe webhook ${endpoint.id}`)
    : errorResult(
        formatBunnyError(`Delete Stripe webhook ${endpoint.id}`, response),
      );
};

/** Delete each endpoint whose address is on one of the hosts. The answer
 * names what was deleted. */
export const removeWebhooks = async (
  io: StripeIo,
  hosts: readonly string[],
): Promise<Result<string[]>> => {
  const listed = await listEndpoints(io);
  if (!listed.ok) return listed;
  const urls = new Set(hosts.map(paymentWebhookUrl));
  return eachInOrder(
    listed.value.filter(({ url }) => urls.has(url)),
    (endpoint) => deleteEndpoint(io, endpoint),
  );
};
