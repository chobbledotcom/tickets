/**
 * Webhook notification module
 * Sends consolidated registration data to configured webhook URLs
 */

import { compact, unique } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import { ErrorCode, logError } from "#lib/logger.ts";

/** Single ticket in the webhook payload */
export type WebhookTicket = {
  event_name: string;
  event_slug: string;
  unit_price: number | null;
  quantity: number;
};

/** Consolidated payload sent to webhook endpoints */
export type WebhookPayload = {
  event_type: "registration.completed";
  name: string;
  email: string;
  phone: string;
  price_paid: number | null;
  currency: string;
  payment_id: string | null;
  tickets: WebhookTicket[];
  timestamp: string;
};

/** Event data needed for webhook notifications */
export type WebhookEvent = {
  id: number;
  name: string;
  slug: string;
  webhook_url: string | null;
  max_attendees: number;
  attendee_count: number;
  unit_price: number | null;
};

/** Attendee data needed for webhook notifications */
export type WebhookAttendee = {
  id: number;
  quantity: number;
  name: string;
  email: string;
  phone: string;
  payment_id?: string | null;
  price_paid?: string | null;
};

/** Registration entry: event + attendee pair */
export type RegistrationEntry = {
  event: WebhookEvent;
  attendee: WebhookAttendee;
};

/**
 * Build a consolidated webhook payload from registration entries
 */
export const buildWebhookPayload = (
  entries: RegistrationEntry[],
  currency: string,
): WebhookPayload => {
  const first = entries[0]!;
  const totalPricePaid = entries.reduce((sum, { attendee, event }) => {
    if (attendee.price_paid) return sum + Number.parseInt(attendee.price_paid, 10);
    if (event.unit_price) return sum + event.unit_price * attendee.quantity;
    return sum;
  }, 0);

  const hasPaidEvent = entries.some(({ event }) => event.unit_price !== null);

  return {
    event_type: "registration.completed",
    name: first.attendee.name,
    email: first.attendee.email,
    phone: first.attendee.phone,
    price_paid: hasPaidEvent ? totalPricePaid : null,
    currency,
    payment_id: first.attendee.payment_id ?? null,
    tickets: entries.map(({ event, attendee }) => ({
      event_name: event.name,
      event_slug: event.slug,
      unit_price: event.unit_price,
      quantity: attendee.quantity,
    })),
    timestamp: new Date().toISOString(),
  };
};

/**
 * Send a webhook payload to a URL
 * Fires and forgets - errors are logged but don't block registration
 */
export const sendWebhook = async (
  webhookUrl: string,
  payload: WebhookPayload,
): Promise<void> => {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    logError({ code: ErrorCode.WEBHOOK_SEND });
  }
};

/**
 * Send consolidated webhook to all unique webhook URLs for the given entries
 */
export const sendRegistrationWebhooks = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<void> => {
  const webhookUrls = unique(compact(entries.map((e) => e.event.webhook_url)));
  if (webhookUrls.length === 0) return;

  const payload = buildWebhookPayload(entries, currency);
  for (const url of webhookUrls) {
    await sendWebhook(url, payload);
  }
};

/**
 * Log attendee registration and send consolidated webhook
 * Used for single-event registrations
 */
export const logAndNotifyRegistration = async (
  event: WebhookEvent,
  attendee: WebhookAttendee,
  currency: string,
): Promise<void> => {
  await logActivity("Attendee registered", event.id);
  await sendRegistrationWebhooks([{ event, attendee }], currency);
};

/**
 * Log and send consolidated webhook for multi-event registrations
 */
export const logAndNotifyMultiRegistration = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<void> => {
  for (const { event } of entries) {
    await logActivity("Attendee registered", event.id);
  }
  await sendRegistrationWebhooks(entries, currency);
};
