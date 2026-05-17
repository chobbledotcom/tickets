/**
 * Webhook notification module
 * Sends consolidated registration data to configured webhook URLs
 */

import { compact, unique } from "#fp";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { addMonthsIso } from "#shared/dates.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { getBuiltSiteByRenewalTokenIndex } from "#shared/db/built-sites.ts";
import { settings } from "#shared/db/settings.ts";
import { type EmailEntry, sendRegistrationEmails } from "#shared/email.ts";
import { fetchText } from "#shared/fetch.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso, nowMs } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import {
  assignAndNotifyBuiltSites,
  pushReadOnlyFrom,
} from "#shared/site-assignment.ts";
import { buildTicketUrl } from "#shared/ticket-url.ts";
import { type ContactInfo, isPaidEvent } from "#shared/types.ts";

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
  months_per_unit: number;
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
export const buildWebhookPayload = (
  entries: RegistrationEntry[],
  currency: string,
): WebhookPayload => {
  const first = entries[0]!;
  const totalPricePaid = entries.reduce(
    (sum, { attendee }) => sum + Number.parseInt(attendee.price_paid, 10),
    0,
  );

  const hasPaidEvent = entries.some(({ event }) => isPaidEvent(event));
  return {
    address: first.attendee.address,
    business_email: settings.businessEmail,
    currency,
    email: first.attendee.email,
    event_type: "registration.completed",
    name: first.attendee.name,
    payment_id: first.attendee.payment_id || null,
    phone: first.attendee.phone,
    price_paid: hasPaidEvent ? totalPricePaid : null,
    special_instructions: first.attendee.special_instructions,
    ticket_url: buildTicketUrl(entries),
    tickets: entries.map(({ event, attendee }) => ({
      date: attendee.date,
      event_name: event.name,
      event_slug: event.slug,
      quantity: attendee.quantity,
      ticket_token: attendee.ticket_token,
      unit_price: event.unit_price,
    })),
    timestamp: nowIso(),
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
    const { ok, status } = await fetchText(webhookUrl, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!ok) {
      const eventName = payload.tickets.map((t) => t.event_name).join(", ");
      logError({
        code: ErrorCode.WEBHOOK_SEND,
        detail: `status=${status} for '${eventName}'`,
        eventId,
      });
    }
  } catch (error) {
    logError({
      code: ErrorCode.WEBHOOK_SEND,
      detail: error instanceof Error ? error.message : String(error),
      eventId,
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
  const webhookUrls = unique(
    compact(entries.map((e) => e.event.webhook_url || null)),
  );
  if (webhookUrls.length === 0) return;

  const payload = await buildWebhookPayload(entries, currency);
  const firstEventId = entries[0]?.event.id;
  await Promise.allSettled(
    webhookUrls.map((url) => sendWebhook(url, payload, firstEventId)),
  );
};

/**
 * Apply renewal deadline bumps for a completed payment.
 * If siteToken is present, look up the built site and bump its READ_ONLY_FROM.
 */
export const applyRenewalsForEntries = async (
  entries: EmailEntry[],
  siteToken: string | undefined,
): Promise<void> => {
  if (!siteToken) return;

  const tokenIndex = await hmacHash(siteToken);
  const site = await getBuiltSiteByRenewalTokenIndex(tokenIndex);
  if (!site) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `Renewal site not found for token index ${tokenIndex.slice(0, 8)}...`,
    });
    return;
  }

  for (const entry of entries) {
    if (entry.event.id !== site.renewalTierEventId) continue;

    const base =
      site.readOnlyFrom && Date.parse(site.readOnlyFrom) > 0
        ? Math.max(nowMs(), Date.parse(site.readOnlyFrom))
        : nowMs();
    const months = entry.attendee.quantity * entry.event.months_per_unit;
    if (months <= 0) continue;

    const newIso = addMonthsIso(new Date(base).toISOString(), months);
    const result = await pushReadOnlyFrom(site, newIso);

    if (result.ok) {
      await logActivity(
        `Renewal of '${site.name}' for ${months} month(s)`,
        entry.event.id,
      );
    } else {
      logError({
        code: ErrorCode.CDN_REQUEST,
        detail: `Failed to push READ_ONLY_FROM for renewal of '${site.name}': ${result.error}`,
      });
      sendNtfyError("CDN_REQUEST");
    }
  }
};

/**
 * Log attendee registration and send consolidated webhook
 * Used for single-event registrations
 *
 * Webhook sends are queued as pending work so they run in the background
 * but complete before the edge runtime tears down the request context.
 */
export const logAndNotifyRegistration = async (
  entries: EmailEntry[],
  siteToken?: string,
): Promise<void> => {
  for (const { event } of entries) {
    await logActivity(`Attendee registered for '${event.name}'`, event);
  }
  const currency = settings.currency;
  addPendingWork(sendRegistrationWebhooks(entries, currency));
  addPendingWork(sendRegistrationEmails(entries, currency));
  addPendingWork(assignAndNotifyBuiltSites(entries));
  addPendingWork(applyRenewalsForEntries(entries, siteToken));
};
