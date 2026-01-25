/**
 * Webhook notification module
 * Sends attendee registration data to configured webhook URLs
 *
 * Note: For security, PII (name, email) is not sent in webhook payloads.
 * External systems should query the API with authentication if they need PII.
 */

import { logActivity } from "#lib/db/activityLog.ts";
import { ErrorCode, logError } from "#lib/logger.ts";

/** Payload sent to webhook endpoints */
export type WebhookPayload = {
  event_type: "attendee.registered";
  event_id: number;
  event_slug: string;
  remaining_places: number;
  total_places: number;
  attendee: {
    id: number;
    quantity: number;
  };
  timestamp: string;
};

/** Event data needed for webhook notifications */
type WebhookEvent = {
  id: number;
  slug: string;
  webhook_url: string | null;
  max_attendees: number;
  attendee_count: number;
};

/** Attendee data needed for webhook notifications */
type WebhookAttendee = { id: number; quantity: number };

/**
 * Send a webhook notification for a new attendee registration
 * Fires and forgets - errors are logged but don't block registration
 */
export const sendRegistrationWebhook = async (
  webhookUrl: string,
  eventId: number,
  eventSlug: string,
  attendeeId: number,
  quantity: number,
  maxAttendees: number,
  attendeeCount: number,
): Promise<void> => {
  const payload: WebhookPayload = {
    event_type: "attendee.registered",
    event_id: eventId,
    event_slug: eventSlug,
    remaining_places: maxAttendees - attendeeCount - quantity,
    total_places: maxAttendees,
    attendee: {
      id: attendeeId,
      quantity,
    },
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Webhook failures should not block registration
    logError({ code: ErrorCode.WEBHOOK_SEND, eventId, attendeeId });
  }
};

/**
 * Notify webhook if configured for the event
 * Safe to call even if no webhook is configured
 */
export const notifyWebhook = async (
  event: WebhookEvent,
  attendee: WebhookAttendee,
): Promise<void> => {
  if (!event.webhook_url) return;

  await sendRegistrationWebhook(
    event.webhook_url,
    event.id,
    event.slug,
    attendee.id,
    attendee.quantity,
    event.max_attendees,
    event.attendee_count,
  );
};

/**
 * Log attendee registration and notify webhook
 * Combines activity logging and webhook notification for successful registrations
 */
export const logAndNotifyRegistration = async (
  event: WebhookEvent,
  attendee: WebhookAttendee,
): Promise<void> => {
  await logActivity(`Added an attendee to event '${event.slug}'`, event.id);
  await notifyWebhook(event, attendee);
};
