import { settings } from "#shared/db/settings.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { CredentialCheck } from "#shared/payment-helpers.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import type { SetupWebhookEndpoint } from "#shared/payments.ts";
import type { StripeClient } from "./client.ts";
import { STRIPE_API_VERSION } from "./request.ts";
import { sanitizeStripeError, stripeClientRuntime } from "./runtime.ts";
import type {
  StripeCreatedWebhookEndpoint,
  StripeWebhookEndpoint,
} from "./schemas.ts";

const fetchWebhookEndpoints = async (
  client: StripeClient,
): Promise<StripeWebhookEndpoint[]> =>
  (await client.webhookEndpoints.list()).data;

const listStaleEndpointIds = async (
  client: StripeClient,
  webhookUrl: string,
  keepEndpointId: string | null | undefined,
): Promise<string[]> =>
  (await fetchWebhookEndpoints(client))
    .filter((endpoint) => endpoint.url === webhookUrl)
    .map((endpoint) => endpoint.id)
    .filter((id) => id !== keepEndpointId);

const deleteWebhookEndpoints = async (
  client: StripeClient,
  ids: readonly string[],
): Promise<void> => {
  for (const id of ids) await client.webhookEndpoints.del(id);
};

const createCheckoutWebhook = (
  client: StripeClient,
  webhookUrl: string,
): Promise<StripeCreatedWebhookEndpoint> =>
  client.webhookEndpoints.create({
    api_version: STRIPE_API_VERSION,
    enabled_events: ["checkout.session.completed"],
    url: webhookUrl,
  });

const isEndpointLimitError = (error: unknown): boolean => {
  const message = (error as Error).message.toLowerCase();
  return (
    message.includes("webhook") &&
    (message.includes("limit") || message.includes("maximum"))
  );
};

export const setupWebhookEndpoint: SetupWebhookEndpoint = async (
  secretKey,
  webhookUrl,
  existingEndpointId,
) => {
  try {
    const client = stripeClientRuntime.create(secretKey);
    let endpoint: StripeCreatedWebhookEndpoint;
    try {
      endpoint = await createCheckoutWebhook(client, webhookUrl);
    } catch (error) {
      if (!isEndpointLimitError(error)) throw error;
      const staleIds = await listStaleEndpointIds(
        client,
        webhookUrl,
        existingEndpointId,
      );
      if (staleIds.length === 0) throw error;
      await deleteWebhookEndpoints(client, staleIds);
      endpoint = await createCheckoutWebhook(client, webhookUrl);
    }
    return {
      endpointId: endpoint.id,
      secret: endpoint.secret,
      success: true,
    };
  } catch (error) {
    logError({
      code: ErrorCode.STRIPE_WEBHOOK_SETUP,
      detail: sanitizeStripeError(error),
    });
    return { error: errorMessage(error), success: false };
  }
};

export const cleanupOldWebhookEndpoints = async (
  secretKey: string,
  webhookUrl: string | null,
  keepEndpointId: string | null,
  alsoDeleteIds: readonly string[] = [],
): Promise<void> => {
  const client = stripeClientRuntime.create(secretKey, 0);
  const staleIds = webhookUrl
    ? await listStaleEndpointIds(client, webhookUrl, keepEndpointId)
    : [];
  const allIds = [...new Set([...staleIds, ...alsoDeleteIds])].filter(
    (id) => id !== keepEndpointId,
  );
  await deleteWebhookEndpoints(client, allIds);
};

export type WebhookEndpointStatus = {
  endpointId: string;
  url: string;
  status: string;
  enabledEvents: string[];
};

export type StripeConnectionTestResult = {
  ok: boolean;
  apiKey: CredentialCheck;
  webhooks: WebhookEndpointStatus[];
  ownEndpointId?: string | null;
  webhookError?: string;
};

const isHealthyOwnEndpoint = (
  endpoint: StripeWebhookEndpoint,
  ownEndpointId: string,
  webhookUrl: string,
): boolean =>
  endpoint.id === ownEndpointId &&
  endpoint.status === "enabled" &&
  endpoint.url === webhookUrl &&
  endpoint.enabled_events.includes("checkout.session.completed");

export const testStripeConnection =
  async (): Promise<StripeConnectionTestResult> => {
    const result: StripeConnectionTestResult = {
      apiKey: { valid: false },
      ok: false,
      webhooks: [],
    };
    const client = await stripeClientRuntime.get();
    if (!client) {
      result.apiKey.error = "No Stripe secret key configured";
      return result;
    }
    try {
      const balance = await client.balance.retrieve();
      result.apiKey = { mode: balance.livemode ? "live" : "test", valid: true };
    } catch (error) {
      result.apiKey = { error: errorMessage(error), valid: false };
      return result;
    }
    result.ownEndpointId = settings.stripe.webhookEndpointId;
    try {
      const endpoints = await fetchWebhookEndpoints(client);
      result.webhooks = endpoints.map((endpoint) => ({
        enabledEvents: endpoint.enabled_events,
        endpointId: endpoint.id,
        status: endpoint.status,
        url: endpoint.url,
      }));
      const ownEndpointId = settings.stripe.webhookEndpointId;
      const webhookUrl = getPaymentWebhookUrl();
      result.ok = endpoints.some((endpoint) =>
        isHealthyOwnEndpoint(endpoint, ownEndpointId, webhookUrl),
      );
    } catch (error) {
      result.webhookError = errorMessage(error);
      return result;
    }
    return result;
  };
