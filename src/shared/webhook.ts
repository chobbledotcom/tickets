/**
 * Webhook notification module
 * Sends consolidated registration data to configured webhook URLs
 */

import { mapNotNullish, sumOf, unique } from "#fp";
import {
  effectivePrice,
  NO_CUSTOM_PRICES,
  packageMemberPriceRule,
} from "#shared/booking/price-tree.ts";
import { bookedSpanDays } from "#shared/dates.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import type { TxScope } from "#shared/db/client.ts";
import { loadPackageMemberPricing } from "#shared/db/groups.ts";
import { settings } from "#shared/db/settings.ts";
import { type EmailEntry, sendRegistrationEmails } from "#shared/email.ts";
import { errorMessage } from "#shared/error-message.ts";
/* jscpd:ignore-start */
import { ErrorCode, logError } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { addPendingWork } from "#shared/pending-work.ts";
/* jscpd:ignore-end */
import { applyRenewalsForEntries } from "#shared/renewal.ts";
import { fetchTextFollowingSafeRedirects } from "#shared/safe-fetch.ts";
import { assignAndNotifyBuiltSites } from "#shared/site-assignment.ts";
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
  /** Maximum day count for a customisable listing — the bound the shared price
   * evaluation validates a booked span against. */
  duration_days: number;
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
  /** The package group this booking belongs to (0 = not a package). Lets the
   * confirmation email group the order's lines under the package by this
   * persisted id rather than membership equality. */
  package_group_id: number;
};

/** Registration entry: listing + attendee pair */
export type RegistrationEntry = {
  listing: WebhookListing;
  attendee: WebhookAttendee;
};

export interface RegistrationWebhookRequest {
  listingId: number;
  payload: WebhookPayload;
  url: string;
}

/** One package group's pricing for the payload: each member's flat override (a
 * positive amount or an explicit free `0`; members with no override are absent)
 * and each customisable member's per-day overrides (day count → minor units) —
 * the loader's shape, minus the fields the payload never reads. */
type PackageGroupPricing = Pick<
  Awaited<ReturnType<typeof loadPackageMemberPricing>>,
  "prices" | "dayPrices"
>;

/** Per-group package pricing, loaded once per payload for the order's package
 * groups. */
type PackageOverrides = ReadonlyMap<number, PackageGroupPricing>;

/** Load the package price overrides for every package group in `entries`, so a
 * package member's full unit price can be reported from its configured override
 * rather than the amount collected. */
export const loadPackageOverrides = async (
  entries: RegistrationEntry[],
): Promise<PackageOverrides> => {
  const groupIds = unique(
    mapNotNullish((e: RegistrationEntry) =>
      e.attendee.package_group_id > 0 ? e.attendee.package_group_id : null,
    )(entries),
  );
  return new Map(
    await Promise.all(
      groupIds.map(
        async (groupId): Promise<[number, PackageGroupPricing]> => [
          groupId,
          await loadPackageMemberPricing(groupId),
        ],
      ),
    ),
  );
};

/** The full per-unit price for a booking line: the shared checkout evaluation
 * ({@link packageMemberPriceRule} + {@link effectivePrice}) over the span
 * actually booked (derived from the stored range) — NOT the amount collected: a
 * discounted/deposit/free-provider order pays less now than the ticket is
 * worth, and dividing the paid-now amount would under-report it. A package
 * member reports its flat override (its base `unit_price` is 0 — the charge
 * lives in the override), else its per-day override, else — like any
 * customisable line, package or standalone — the listing's own entered day
 * price for the booked span; everything else reports the listing's base. */
const ticketUnitPrice = (
  entry: RegistrationEntry,
  overrides: PackageOverrides,
): number => {
  const { listing, attendee } = entry;
  const groupPricing =
    attendee.package_group_id > 0
      ? overrides.get(attendee.package_group_id)
      : undefined;
  const rule = packageMemberPriceRule(
    groupPricing?.prices.get(listing.id),
    groupPricing?.dayPrices.get(listing.id),
    listing.customisable_days,
  );
  return effectivePrice(
    rule,
    listing,
    NO_CUSTOM_PRICES,
    bookedSpanDays(attendee.date, attendee.end_date),
  );
};

/**
 * Build a consolidated webhook payload from registration entries
 */
export const buildWebhookPayload = (
  entries: RegistrationEntry[],
  currency: string,
  overrides: PackageOverrides = new Map(),
): WebhookPayload => {
  const first = entries[0]!;
  const totalPricePaid = sumOf((e: RegistrationEntry) =>
    Number.parseInt(e.attendee.price_paid, 10),
  )(entries);

  // A package member's base listing is free (the charge is the package
  // override), so `isPaidListing` alone would report `price_paid: null` for an
  // order that charged the buyer. Treat any positive amount actually paid as
  // paid so integrations don't under-count package revenue.
  const isPaidOrder =
    entries.some(({ listing }) => isPaidListing(listing)) || totalPricePaid > 0;
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
    price_paid: isPaidOrder ? totalPricePaid : null,
    special_instructions: first.attendee.special_instructions,
    ticket_url: buildTicketUrl(entries),
    tickets: entries.map((entry) => ({
      date: entry.attendee.date,
      listing_name: entry.listing.name,
      listing_slug: entry.listing.slug,
      quantity: entry.attendee.quantity,
      ticket_token: entry.attendee.ticket_token,
      unit_price: ticketUnitPrice(entry, overrides),
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
    const { ok, status } = await postRegistrationWebhook(webhookUrl, payload);
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
      detail: errorMessage(error),
      listingId,
    });
  }
};

export const postRegistrationWebhook = (
  webhookUrl: string,
  payload: WebhookPayload,
): ReturnType<typeof fetchTextFollowingSafeRedirects> =>
  fetchTextFollowingSafeRedirects(webhookUrl, {
    body: JSON.stringify(payload),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

export const registrationWebhookRequests = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<RegistrationWebhookRequest[]> => {
  const first = entries[0];
  if (first === undefined) return [];
  const urls = unique(
    mapNotNullish(
      (entry: RegistrationEntry) => entry.listing.webhook_url || null,
    )(entries),
  );
  if (urls.length === 0) return [];
  const payload = buildWebhookPayload(
    entries,
    currency,
    await loadPackageOverrides(entries),
  );
  return urls.map((url) => ({
    listingId: first.listing.id,
    payload,
    url,
  }));
};

/**
 * Send consolidated webhook to all unique webhook URLs for the given entries
 */
export const sendRegistrationWebhooks = async (
  entries: RegistrationEntry[],
  currency: string,
): Promise<void> => {
  const requests = await registrationWebhookRequests(entries, currency);
  await Promise.allSettled(
    requests.map(({ listingId, payload, url }) =>
      sendWebhook(url, payload, listingId),
    ),
  );
};

/** Store every registration activity, optionally inside a wider idempotent
 * payment-effect transaction. */
export const logRegistrationActivities = async (
  entries: EmailEntry[],
  transaction?: TxScope,
): Promise<void> => {
  for (const { listing, attendee } of entries) {
    await logActivity(
      `Attendee registered for '${listing.name}'`,
      listing,
      attendee.id,
      transaction,
    );
  }
};

/** Log a non-payment registration and queue its external notifications. Paid
 * completion calls each external function directly and awaits it so its durable
 * plan can mark only the delivery that returned. */
export const logAndNotifyRegistration = async (
  entries: EmailEntry[],
  siteTokenIndex?: string,
): Promise<void> => {
  await logRegistrationActivities(entries);
  const currency = settings.currency;
  addPendingWork(sendRegistrationWebhooks(entries, currency));
  addPendingWork(sendRegistrationEmails(entries, currency));
  addPendingWork(assignAndNotifyBuiltSites(entries));
  addPendingWork(applyRenewalsForEntries(entries, siteTokenIndex));
};
