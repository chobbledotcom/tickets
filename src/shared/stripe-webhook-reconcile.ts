/* jscpd:ignore-start */
import type Stripe from "stripe";
import { unique } from "#fp";
import { executeWithoutCacheInvalidation } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import {
  createStripeWebhookEndpoint,
  getStripeClient,
  sanitizeErrorDetail,
} from "#shared/stripe.ts";
import {
  REQUIRED_STRIPE_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_EVENTS_VERSION,
} from "#shared/stripe-webhook-events.ts";

/* jscpd:ignore-end */

const RECONCILE_LOCK_PREFIX = "pending:";
const RECONCILE_LOCK_TTL_MS = 2 * 60 * 1000;

const acquireReconcileLock = async (): Promise<string | null> => {
  const now = new Date();
  const stamp = `${RECONCILE_LOCK_PREFIX}${now.toISOString()}`;
  const cutoff = new Date(now.getTime() - RECONCILE_LOCK_TTL_MS).toISOString();
  const result = await executeWithoutCacheInvalidation(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?
       WHERE settings.value != ?
         AND (settings.value NOT LIKE ? OR SUBSTR(settings.value, ?) < ?)`,
    [
      CONFIG_KEYS.STRIPE_WEBHOOK_EVENTS_VERSION,
      stamp,
      stamp,
      STRIPE_WEBHOOK_EVENTS_VERSION,
      `${RECONCILE_LOCK_PREFIX}%`,
      RECONCILE_LOCK_PREFIX.length + 1,
      cutoff,
    ],
  );
  return result.rowsAffected === 1 ? stamp : null;
};

const releaseReconcileLock = async (stamp: string): Promise<void> => {
  await executeWithoutCacheInvalidation(
    "DELETE FROM settings WHERE key = ? AND value = ?",
    [CONFIG_KEYS.STRIPE_WEBHOOK_EVENTS_VERSION, stamp],
  );
};

const isMissingEndpoint = (error: unknown): boolean =>
  error instanceof Error &&
  "statusCode" in error &&
  error.statusCode === 404 &&
  "code" in error &&
  error.code === "resource_missing";

const getEndpointOrNull = async (
  client: Stripe,
  endpointId: string,
): Promise<Stripe.WebhookEndpoint | null> => {
  try {
    return await client.webhookEndpoints.retrieve(endpointId);
  } catch (error) {
    if (isMissingEndpoint(error)) return null;
    throw error;
  }
};

const hasRequiredEvents = (endpoint: Stripe.WebhookEndpoint): boolean =>
  endpoint.enabled_events.includes("*") ||
  REQUIRED_STRIPE_WEBHOOK_EVENTS.every((event) =>
    endpoint.enabled_events.includes(event),
  );

const updateExistingEndpoint = async (
  client: Stripe,
  endpoint: Stripe.WebhookEndpoint,
  webhookUrl: string,
): Promise<void> => {
  if (endpoint.url === webhookUrl && hasRequiredEvents(endpoint)) return;
  const enabledEvents = endpoint.enabled_events.includes("*")
    ? endpoint.enabled_events
    : unique([...endpoint.enabled_events, ...REQUIRED_STRIPE_WEBHOOK_EVENTS]);
  await client.webhookEndpoints.update(endpoint.id, {
    // Stripe types its response as string[] but accepts the same documented
    // values through a narrower request union. Preserve every existing event.
    enabled_events:
      enabledEvents as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
    url: webhookUrl,
  });
};

const replaceEndpoint = async (
  client: Stripe,
  webhookUrl: string,
  staleEndpointId: string,
): Promise<void> => {
  if (staleEndpointId) {
    try {
      await client.webhookEndpoints.del(staleEndpointId);
    } catch (error) {
      if (!isMissingEndpoint(error)) throw error;
    }
  }
  const endpoint = await createStripeWebhookEndpoint(client, webhookUrl);
  await settings.update.stripe.webhookConfig({
    endpointId: endpoint.id,
    secret: endpoint.secret,
  });
};

/** Reconcile one stored Stripe install after an event-set upgrade. A valid
 * endpoint is updated in place, which preserves its signing secret. Replacement
 * happens only when the recorded endpoint or its signing secret is gone. */
export const reconcileStoredStripeWebhook = async (
  webhookUrl: string,
): Promise<void> => {
  if (
    settings.paymentProvider !== "stripe" ||
    settings.stripe.webhookEventsVersion === STRIPE_WEBHOOK_EVENTS_VERSION
  ) {
    return;
  }
  const lock = await acquireReconcileLock();
  if (!lock) return;

  try {
    await settings.loadKeys([
      CONFIG_KEYS.STRIPE_SECRET_KEY,
      CONFIG_KEYS.STRIPE_WEBHOOK_ENDPOINT_ID,
      CONFIG_KEYS.STRIPE_WEBHOOK_SECRET,
    ]);
    const client = await getStripeClient();
    if (!client) {
      await settings.update.stripe.webhookEventsVersion(
        STRIPE_WEBHOOK_EVENTS_VERSION,
      );
      return;
    }

    const endpointId = settings.stripe.webhookEndpointId;
    const endpoint =
      endpointId && settings.stripe.webhookSecret
        ? await getEndpointOrNull(client, endpointId)
        : null;
    if (endpoint) {
      await updateExistingEndpoint(client, endpoint, webhookUrl);
    } else {
      await replaceEndpoint(
        client,
        webhookUrl,
        settings.stripe.webhookSecret ? "" : endpointId,
      );
    }
    await settings.update.stripe.webhookEventsVersion(
      STRIPE_WEBHOOK_EVENTS_VERSION,
    );
  } catch (error) {
    await releaseReconcileLock(lock);
    logError({
      code: ErrorCode.STRIPE_WEBHOOK_SETUP,
      detail: `reconcile ${sanitizeErrorDetail(error)}`,
      error,
    });
  }
};
