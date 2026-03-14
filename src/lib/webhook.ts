/**
 * Webhook notification module
 * Sends consolidated registration data to configured webhook URLs
 */

import { compact, unique } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import { type EmailEntry, sendRegistrationEmails } from "#lib/email.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import { addPendingWork } from "#lib/pending-work.ts";
import { buildTicketUrl } from "#lib/ticket-url.ts";
import { type ContactInfo, isPaidEvent } from "#lib/types.ts";
import { nowIso } from "#lib/now.ts";
import { getBusinessEmailFromDb } from "#lib/business-email.ts";

/** Single ticket in the webhook payload */
export type WebhookTicket = {
  event_name: string;
  event_slug: string;
  unit_price: number;
  quantity: number;
  date: string | null;
  ticket_token: string;
};

/** Consolidated payload sent to webhook endpoints */
export type WebhookPayload = ContactInfo & {
  event_type: "registration.completed";
  price_paid: number | null;
  currency: string;
  payment_id: string | null;
  ticket_url: string;
  tickets: WebhookTicket[];
  timestamp: string;
  business_email: string;
};

/** Event data needed for webhook notifications */
export type WebhookEvent = {
  id: number;
  name: string;
  slug: string;
  webhook_url: string;
  max_attendees: number;
  attendee_count: number;
  unit_price: number;
  can_pay_more: boolean;
};

/** Attendee data needed for webhook notifications */
export type WebhookAttendee = ContactInfo & {
  id: number;
  quantity: number;
  payment_id: string;
  price_paid: string;
  ticket_token: string;
  date: string | null;
};

/** Registration entry: event + attendee pair */
export type RegistrationEntry = {
  event: WebhookEvent;
  attendee: WebhookAttendee;
};

/**
 * Build a consolidated webhook payload from registration entries
 */
export const buildWebhookPayload = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<WebhookPayload> => {
  const first = entries[0]!;
  const totalPricePaid = entries.reduce(
    (sum, { attendee }) => sum + Number.parseInt(attendee.price_paid, 10),
    0,
  );

  const hasPaidEvent = entries.some(({ event }) => isPaidEvent(event));
  const businessEmail = await getBusinessEmailFromDb();

  return {
    event_type: "registration.completed",
    name: first.attendee.name,
    email: first.attendee.email,
    phone: first.attendee.phone,
    address: first.attendee.address,
    special_instructions: first.attendee.special_instructions,
    price_paid: hasPaidEvent ? totalPricePaid : null,
    currency,
    payment_id: first.attendee.payment_id || null,
    ticket_url: buildTicketUrl(entries),
    tickets: entries.map(({ event, attendee }) => ({
      event_name: event.name,
      event_slug: event.slug,
      unit_price: event.unit_price,
      quantity: attendee.quantity,
      date: attendee.date,
      ticket_token: attendee.ticket_token,
    })),
    timestamp: nowIso(),
    business_email: businessEmail,
  };
};

/**
 * Send a webhook payload to a URL
 * Fires and forgets - errors are logged but don't block registration
 */
export const sendWebhook = async (
  webhookUrl: string,
  payload: WebhookPayload,
  eventId?: number,
): Promise<void> => {
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const eventName = payload.tickets.map((t) => t.event_name).join(", ");
      logError({
        code: ErrorCode.WEBHOOK_SEND,
        eventId,
        detail: `status=${response.status} for '${eventName}'`,
      });
    }
  } catch (error) {
    logError({
      code: ErrorCode.WEBHOOK_SEND,
      eventId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Send consolidated webhook to all unique webhook URLs for the given entries
 */
export const sendRegistrationWebhooks = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<void> => {
  const webhookUrls = unique(compact(
    entries.map((e) => e.event.webhook_url || null),
  ));
  if (webhookUrls.length === 0) return;

  const payload = await buildWebhookPayload(entries, currency);
  const firstEventId = entries[0]?.event.id;
  await Promise.allSettled(
    webhookUrls.map((url) => sendWebhook(url, payload, firstEventId)),
  );
};

/**
 * Log attendee registration and send consolidated webhook
 * Used for single-event registrations
 *
 * Webhook sends are queued as pending work so they run in the background
 * but complete before the edge runtime tears down the request context.
 */
export const logAndNotifyRegistration = async (
  event: EmailEntry["event"],
  attendee: WebhookAttendee,
  currency: string,
): Promise<void> => {
  await logActivity(`Attendee registered for '${event.name}'`, event);
  const entries: EmailEntry[] = [{ event, attendee }];
  addPendingWork(sendRegistrationWebhooks(entries, currency));
  addPendingWork(sendRegistrationEmails(entries, currency));
};

/**
 * Log and send consolidated webhook for multi-event registrations
 */
export const logAndNotifyMultiRegistration = async (
  entries: EmailEntry[],
  currency: string,
): Promise<void> => {
  for (const { event } of entries) {
    await logActivity(`Attendee registered for '${event.name}'`, event);
  }
  addPendingWork(sendRegistrationWebhooks(entries, currency));
  addPendingWork(sendRegistrationEmails(entries, currency));
};
