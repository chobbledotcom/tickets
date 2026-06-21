/**
 * Webhook notification module
 * Sends consolidated registration data to configured webhook URLs
 */

import { mapNotNullish, sumOf, unique } from "#fp";
import { logActivity } from "#shared/db/activityLog.ts";
import { getBuiltSiteByRenewalTokenIndex } from "#shared/db/built-sites.ts";
import { settings } from "#shared/db/settings.ts";
import { type EmailEntry, sendRegistrationEmails } from "#shared/email.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { addPendingWork } from "#shared/pending-work.ts";
import { fetchTextFollowingSafeRedirects } from "#shared/safe-fetch.ts";
import {
  addMonthsToRenewalDeadline,
  assignAndNotifyBuiltSites,
  isQualifyingTierListing,
  syncReadOnlyFrom,
} from "#shared/site-assignment.ts";
import { buildTicketUrl } from "#shared/ticket-url.ts";
import {
  type ContactInfo,
  type DayPrices,
  isPaidListing,
} from "#shared/types.ts";
import { isSafeServerFetchUrl } from "#shared/url-safety.ts";

/** Single ticket in the webhook payload */
export type WebhookTicket = {
  listing_name: string;
  listing_slug: string;
  unit_price: number;
  quantity: number;
  date: string | null;
  ticket_token: string;
};

/** Consolidated payload sent to webhook endpoints */
export type WebhookPayload = ContactInfo & {
  notification_type: "registration.completed";
  price_paid: number | null;
  /** Outstanding order balance still owed, in minor units. 0 when fully paid;
   * positive when a booking was taken without collecting payment (e.g. no
   * payment provider is configured), so integrations see the amount to collect. */
  amount_owed: number;
  currency: string;
  payment_id: string | null;
  ticket_url: string;
  tickets: WebhookTicket[];
  timestamp: string;
  business_email: string;
};

/** Listing data needed for webhook notifications */
export type WebhookListing = {
  id: number;
  name: string;
  slug: string;
  webhook_url: string;
  max_attendees: number;
  attendee_count: number;
  unit_price: number;
  can_pay_more: boolean;
  customisable_days: boolean;
  day_prices: DayPrices;
  months_per_unit: number;
};

/** Attendee data needed for webhook notifications */
export type WebhookAttendee = ContactInfo & {
  id: number;
  quantity: number;
  payment_id: string;
  price_paid: string;
  /** Order-level outstanding balance in minor units; 0 when fully paid. Shared
   * across every booking on the order (it is an attendee-level figure). */
  remaining_balance: number;
  ticket_token: string;
  date: string | null;
  /** Exclusive end of the booked range (YYYY-MM-DD), or null for date-less
   * bookings. Used to render the true span of multi-day/customisable bookings. */
  end_date: string | null;
};

/** Registration entry: listing + attendee pair */
export type RegistrationEntry = {
  listing: WebhookListing;
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
  const totalPricePaid = sumOf((e: RegistrationEntry) =>
    Number.parseInt(e.attendee.price_paid, 10),
  )(entries);

  const hasPaidListing = entries.some(({ listing }) => isPaidListing(listing));
  return {
    address: first.attendee.address,
    // Order-level balance — the same on every entry, so read it from the first
    // rather than summing (summing would multiply it per booking line).
    amount_owed: first.attendee.remaining_balance,
    business_email: settings.businessEmail,
    currency,
    email: first.attendee.email,
    name: first.attendee.name,
    notification_type: "registration.completed",
    payment_id: first.attendee.payment_id || null,
    phone: first.attendee.phone,
    price_paid: hasPaidListing ? totalPricePaid : null,
    special_instructions: first.attendee.special_instructions,
    ticket_url: buildTicketUrl(entries),
    tickets: entries.map(({ listing, attendee }) => ({
      date: attendee.date,
      listing_name: listing.name,
      listing_slug: listing.slug,
      quantity: attendee.quantity,
      ticket_token: attendee.ticket_token,
      unit_price: listing.unit_price,
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
  listingId?: number,
): Promise<void> => {
  // Defense-in-depth against SSRF: never fetch an internal/non-https URL, even
  // if one was stored before write-time validation existed.
  if (!isSafeServerFetchUrl(webhookUrl)) {
    logError({
      code: ErrorCode.WEBHOOK_SEND,
      detail: "Refused to send webhook to an unsafe URL",
      listingId,
    });
    return;
  }
  try {
    const { ok, status } = await fetchTextFollowingSafeRedirects(webhookUrl, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!ok) {
      const listingName = payload.tickets.map((t) => t.listing_name).join(", ");
      logError({
        code: ErrorCode.WEBHOOK_SEND,
        detail: `status=${status} for '${listingName}'`,
        listingId,
      });
    }
  } catch (error) {
    logError({
      code: ErrorCode.WEBHOOK_SEND,
      detail: error instanceof Error ? error.message : String(error),
      listingId,
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
    mapNotNullish((e: RegistrationEntry) => e.listing.webhook_url || null)(
      entries,
    ),
  );
  if (webhookUrls.length === 0) return;

  const payload = await buildWebhookPayload(entries, currency);
  const firstListingId = entries[0]?.listing.id;
  await Promise.allSettled(
    webhookUrls.map((url) => sendWebhook(url, payload, firstListingId)),
  );
};

/**
 * Apply renewal deadline bumps for a completed payment.
 * If siteTokenIndex is present, look up the built site and bump its READ_ONLY_FROM.
 *
 * The index is the HMAC of the plain renewal token. Free reservations compute
 * it from `ctx.siteToken`; paid checkouts read it back from session metadata
 * (where the provider only ever sees the hashed form).
 */
export const applyRenewalsForEntries = async (
  entries: EmailEntry[],
  siteTokenIndex: string | undefined,
): Promise<void> => {
  if (!siteTokenIndex) return;

  const invalidEntry = entries.find(
    ({ listing }) => !isQualifyingTierListing(listing),
  );
  if (invalidEntry) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `Renewal rejected: listing ${invalidEntry.listing.id} is not an active hidden purchase-only renewal tier`,
      listingId: invalidEntry.listing.id,
    });
    return;
  }

  const site = await getBuiltSiteByRenewalTokenIndex(siteTokenIndex);
  if (!site) {
    logError({
      code: ErrorCode.DATA_INVALID,
      detail: `Renewal site not found for token index ${siteTokenIndex.slice(
        0,
        8,
      )}...`,
    });
    return;
  }

  const renewalEntries = entries
    .map((entry) => ({
      entry,
      months: entry.attendee.quantity * entry.listing.months_per_unit,
    }))
    .filter(({ months }) => months > 0);
  const totalMonths = sumOf((r: { months: number }) => r.months)(
    renewalEntries,
  );

  const result = await syncReadOnlyFrom(
    site,
    addMonthsToRenewalDeadline(site, totalMonths),
  );
  if (result.ok) {
    await logActivity(
      `Renewal of '${site.name}' for ${totalMonths} month(s)`,
      renewalEntries[0]!.entry.listing.id,
    );
  } else {
    logError({
      code: ErrorCode.CDN_REQUEST,
      detail: `Failed to push READ_ONLY_FROM for renewal of '${site.name}': ${result.error}`,
    });
    sendNtfyError("CDN_REQUEST");
  }
};

/**
 * Log attendee registration and send consolidated webhook
 * Used for single-listing registrations
 *
 * Webhook sends are queued as pending work so they run in the background
 * but complete before the edge runtime tears down the request context.
 */
export const logAndNotifyRegistration = async (
  entries: EmailEntry[],
  siteTokenIndex?: string,
): Promise<void> => {
  for (const { listing } of entries) {
    await logActivity(`Attendee registered for '${listing.name}'`, listing);
  }
  const currency = settings.currency;
  addPendingWork(sendRegistrationWebhooks(entries, currency));
  addPendingWork(sendRegistrationEmails(entries, currency));
  addPendingWork(assignAndNotifyBuiltSites(entries));
  addPendingWork(applyRenewalsForEntries(entries, siteTokenIndex));
};
