/**
 * Webhook notification module
 * Sends attendee registration data to configured webhook URLs
 */

/** Payload sent to webhook endpoints */
export type WebhookPayload = {
  event_type: "attendee.registered";
  event_id: number;
  event_name: string;
  attendee: {
    name: string;
    email: string;
    quantity: number;
  };
  timestamp: string;
};

/**
 * Send a webhook notification for a new attendee registration
 * Fires and forgets - errors are logged but don't block registration
 */
export const sendRegistrationWebhook = async (
  webhookUrl: string,
  eventId: number,
  eventName: string,
  attendeeName: string,
  attendeeEmail: string,
  quantity: number,
): Promise<void> => {
  const payload: WebhookPayload = {
    event_type: "attendee.registered",
    event_id: eventId,
    event_name: eventName,
    attendee: {
      name: attendeeName,
      email: attendeeEmail,
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
    // In a production system, you might want to queue for retry
  }
};

/**
 * Notify webhook if configured for the event
 * Safe to call even if no webhook is configured
 */
export const notifyWebhook = async (
  event: { id: number; name: string; webhook_url: string | null },
  attendee: { name: string; email: string; quantity: number },
): Promise<void> => {
  if (!event.webhook_url) return;

  await sendRegistrationWebhook(
    event.webhook_url,
    event.id,
    event.name,
    attendee.name,
    attendee.email,
    attendee.quantity,
  );
};
