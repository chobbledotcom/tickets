import { settings } from "#shared/db/settings.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { CredentialCheck } from "#shared/payment-helpers.ts";
import type { SetupWebhookEndpoint } from "#shared/payments.ts";
import { STRIPE_API_VERSION, type StripeClient } from "./client.ts";
import { sanitizeStripeError, stripeClientRuntime } from "./runtime.ts";
import type {
  StripeWebhookEndpoint,
  StripeWebhookEndpointWrite,
} from "./schemas.ts";

const fetchWebhookEndpoints = async (
  client: StripeClient,
): Promise<StripeWebhookEndpoint[]> =>
  (await client.webhookEndpoints.list({ limit: 100 })).data;

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
): Promise<StripeWebhookEndpointWrite> =>
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

export const setupWebhookEndpointImpl: SetupWebhookEndpoint = async (
  secretKey,
  webhookUrl,
  existingEndpointId,
) => {
  try {
    const client = stripeClientRuntime.create(secretKey);
    let endpoint: StripeWebhookEndpointWrite;
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
    if (!endpoint.secret) {
      return { error: "Stripe did not return webhook secret", success: false };
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

export const cleanupOldWebhookEndpointsImpl = async (
  secretKey: string,
  webhookUrl: string,
  keepEndpointId: string,
  alsoDeleteIds: readonly string[] = [],
): Promise<void> => {
  const client = stripeClientRuntime.create(secretKey);
  const staleIds = await listStaleEndpointIds(
    client,
    webhookUrl,
    keepEndpointId,
  );
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

export const testStripeConnectionImpl =
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
    } catch (error) {
      result.webhookError = errorMessage(error);
      return result;
    }
    result.ok = result.apiKey.valid && result.webhooks.length > 0;
    return result;
  };
