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
import {
  type ActivityToLog,
  logActivities,
  logActivity,
} from "#shared/db/activity-log.ts";
import { getBuiltSiteByRenewalTokenIndex } from "#shared/db/built-sites.ts";
import { settings } from "#shared/db/settings.ts";
import {
  type EmailEntry,
  registrationEmailDelivery,
  sendRegistrationEmails,
} from "#shared/email.ts";
import { fetchText } from "#shared/fetch.ts";
/* jscpd:ignore-start */
import { ErrorCode, logError, logErrorLocal } from "#shared/logger.ts";
import { nowIso } from "#shared/now.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { addPendingWork } from "#shared/pending-work.ts";
/* jscpd:ignore-end */
import {
  loadRegistrationPackageFacts,
  type RegistrationDeliveryResult,
  type RegistrationNotification,
  type RegistrationPackageFacts,
  type RegistrationPackagePricing,
  registrationDeliveryResult,
} from "#shared/registration-package-facts.ts";
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

/** One package group's pricing for the payload: each member's flat override (a
 * positive amount or an explicit free `0`; members with no override are absent)
 * and each customisable member's per-day overrides (day count → minor units) —
 * the loader's shape, minus the fields the payload never reads. */
type PackagePricingByGroup = ReadonlyMap<number, RegistrationPackagePricing>;

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
  pricingByGroup: PackagePricingByGroup,
): number => {
  const { listing, attendee } = entry;
  const groupPricing =
    attendee.package_group_id > 0
      ? pricingByGroup.get(attendee.package_group_id)
      : undefined;
  const rule = packageMemberPriceRule(
    groupPricing?.priceMap.get(listing.id),
    groupPricing?.dayPriceMap.get(listing.id),
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
  pricingByGroup: PackagePricingByGroup = new Map(),
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
      unit_price: ticketUnitPrice(entry, pricingByGroup),
    })),
    timestamp: nowIso(),
  };
};

export type WebhookDelivery =
  | { delivered: true }
  | {
      delivered: false;
      reason: "rejected" | "transport" | "unsafe_url";
    };

const MAX_REGISTRATION_WEBHOOK_URLS = 16;
const REGISTRATION_WEBHOOK_TIMEOUT_MS = 10_000;
const REGISTRATION_DELIVERY_FAILED =
  "Registration notification delivery failed";

/** Send one direct webhook request without blocking registration on failure. */
export const sendWebhook = async (
  webhookUrl: string,
  payload: WebhookPayload,
): Promise<WebhookDelivery> => {
  if (!isSafeServerFetchUrl(webhookUrl)) {
    return { delivered: false, reason: "unsafe_url" };
  }
  try {
    const { ok } = await fetchText(webhookUrl, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(REGISTRATION_WEBHOOK_TIMEOUT_MS),
    });
    return ok ? { delivered: true } : { delivered: false, reason: "rejected" };
  } catch (error) {
    if (
      !(error instanceof TypeError) &&
      !(error instanceof DOMException && error.name === "TimeoutError")
    ) {
      throw error;
    }
    return { delivered: false, reason: "transport" };
  }
};

/**
 * Send consolidated webhook to all unique webhook URLs for the given entries
 */
export const sendRegistrationWebhooks: RegistrationNotification<
  RegistrationEntry
> = async (entries, currency, suppliedFacts) => {
  const webhookUrls = registrationWebhookUrls(entries);
  if (webhookUrls.length === 0) return { failed: false };
  if (webhookUrls.length > MAX_REGISTRATION_WEBHOOK_URLS) {
    return { failed: true };
  }

  const facts = suppliedFacts ?? (await loadRegistrationPackageFacts(entries));
  const payload = buildWebhookPayload(entries, currency, facts.pricingByGroup);
  const results = await Promise.allSettled(
    webhookUrls.map((url) => sendWebhook(url, payload)),
  );
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const deliveries = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  return registrationDeliveryResult(deliveries);
};

const completedRegistrationDelivery =
  (code: (typeof ErrorCode)["EMAIL_SEND" | "WEBHOOK_SEND"]) =>
  (
    result: PromiseSettledResult<RegistrationDeliveryResult>,
  ): RegistrationDeliveryResult => {
    if (result.status === "rejected") {
      logError({ code, error: result.reason });
      throw result.reason;
    }
    return result.value;
  };

const recordRegistrationDeliveryFailure = async (): Promise<void> => {
  try {
    await logActivities([{ message: REGISTRATION_DELIVERY_FAILED }]);
  } catch (error) {
    logErrorLocal({
      code: ErrorCode.DB_QUERY,
      detail: "Registration delivery failure activity write",
    });
    throw error;
  }
};

const sendRegistrationNotifications = async (
  entries: EmailEntry[],
  currency: string,
  packageFacts?: RegistrationPackageFacts,
): Promise<void> => {
  const [webhookResult, emailResult] = await Promise.allSettled([
    sendRegistrationWebhooks(entries, currency, packageFacts),
    sendRegistrationEmails(entries, currency, packageFacts),
  ]);
  const deliveries = [
    completedRegistrationDelivery(ErrorCode.WEBHOOK_SEND)(webhookResult),
    completedRegistrationDelivery(ErrorCode.EMAIL_SEND)(emailResult),
  ];
  if (deliveries.some(({ failed }) => failed)) {
    await recordRegistrationDeliveryFailure();
  }
};

const registrationWebhookUrls = (entries: RegistrationEntry[]): string[] =>
  unique(
    mapNotNullish(
      (entry: RegistrationEntry) => entry.listing.webhook_url || null,
    )(entries),
  );

const queueRegistrationNotifications = async (
  entries: EmailEntry[],
  currency: string,
  suppliedPackageFacts?: RegistrationPackageFacts,
): Promise<void> => {
  const needsPackageFacts =
    registrationWebhookUrls(entries).length > 0 ||
    registrationEmailDelivery(entries) !== null;
  const packageFacts = needsPackageFacts
    ? (suppliedPackageFacts ?? (await loadRegistrationPackageFacts(entries)))
    : suppliedPackageFacts;
  addPendingWork(
    sendRegistrationNotifications(entries, currency, packageFacts),
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
 * Notification preparation and sends are queued as pending work so they run in
 * the background but complete before the edge runtime tears down the request
 * context.
 */
export const logAndNotifyRegistration = async (
  entries: EmailEntry[],
  siteTokenIndex?: string,
  priorActivities: readonly ActivityToLog[] = [],
  suppliedPackageFacts?: RegistrationPackageFacts,
): Promise<void> => {
  await logActivities([
    ...priorActivities,
    ...entries.map(({ listing, attendee }) => ({
      attendeeId: attendee.id,
      listing,
      message: `Attendee registered for '${listing.name}'`,
    })),
  ]);
  const currency = settings.currency;
  addPendingWork(
    queueRegistrationNotifications(entries, currency, suppliedPackageFacts),
  );
  addPendingWork(assignAndNotifyBuiltSites(entries));
  addPendingWork(applyRenewalsForEntries(entries, siteTokenIndex));
};
