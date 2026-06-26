import { expect } from "@std/expect";
import { beforeEach } from "@std/testing/bdd";
import { parseFlashValue } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { toMajorUnits } from "#shared/currency.ts";
import type { CreateAttendeeResult } from "#shared/db/attendee-types.ts";
import { decryptAttendees, getAttendeesRaw } from "#shared/db/attendees.ts";
import type { BuiltSiteFormInput } from "#shared/db/built-sites.ts";
import type { GroupInput } from "#shared/db/groups.ts";
import type { HolidayInput } from "#shared/db/holidays.ts";
import { getListingWithCount, type ListingInput } from "#shared/db/listings.ts";
import {
  type LogisticsAssignment,
  setLogisticsAssignments,
} from "#shared/db/logistics.ts";
import type {
  Attendee,
  DayPrices,
  Group,
  Holiday,
  Listing,
  ListingWithCount,
} from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { testListingInput } from "#test-utils/factories.ts";
import type { BookAttendeeOpts } from "#test-utils/internal.ts";

const bool = (v: unknown): string => (v ? "1" : "");
const optionalNumber = (v: number | null | undefined): string =>
  v != null ? String(v) : "";
const optionalPrice = (v: number | null | undefined): string =>
  v != null ? toMajorUnits(v) : "";
const formatBookableDaysForForm = (days: string[]): string => days.join(",");

/** Serialize a DayPrices map into the form's `day_price_<n>` fields. */
const dayPriceFormFields = (
  dayPrices: DayPrices | undefined,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [days, price] of Object.entries(dayPrices ?? {})) {
    result[`day_price_${days}`] = toMajorUnits(price);
  }
  return result;
};

const splitClosesAt = (
  update: string | undefined,
  existing: string | null,
): { date: string; time: string } => {
  const value = update !== undefined ? update : (existing?.slice(0, 16) ?? "");
  if (!value) return { date: "", time: "" };
  const [date = "", time = ""] = value.split("T");
  return { date, time };
};

const pickField = <T>(update: T | undefined, existing: T): T =>
  update !== undefined ? update : existing;

const buildCreateListingForm = (
  input: Omit<ListingInput, "slug" | "slugIndex">,
): Record<string, string> => {
  const closesAtParts = splitClosesAt(input.closesAt, null);
  const dateParts = splitClosesAt(input.date, null);
  const initialSiteMonths = input.assignBuiltSite
    ? (input.initialSiteMonths ?? 1)
    : (input.initialSiteMonths ?? 0);
  return {
    assign_built_site: bool(input.assignBuiltSite),
    bookable_days: input.bookableDays
      ? formatBookableDaysForForm(input.bookableDays)
      : "",
    can_pay_more: bool(input.canPayMore),
    closes_at_date: closesAtParts.date,
    closes_at_time: closesAtParts.time,
    customisable_days: bool(input.customisableDays),
    date_date: dateParts.date,
    date_time: dateParts.time,
    description: input.description ?? "",
    duration_days: optionalNumber(input.durationDays),
    uses_logistics: bool(input.usesLogistics),
    ...dayPriceFormFields(input.dayPrices),
    fields: input.fields ?? "email",
    group_id: String(input.groupId ?? 0),
    hidden: bool(input.hidden),
    initial_site_months: String(initialSiteMonths),
    listing_type: input.listingType ?? "",
    location: input.location ?? "",
    max_attendees: String(input.maxAttendees),
    max_price: toMajorUnits(input.maxPrice),
    max_quantity: String(input.maxQuantity ?? 1),
    maximum_days_after: optionalNumber(input.maximumDaysAfter),
    minimum_days_before: optionalNumber(input.minimumDaysBefore),
    months_per_unit: String(input.monthsPerUnit ?? 0),
    name: input.name,
    non_transferable: bool(input.nonTransferable),
    purchase_only: bool(input.purchaseOnly),
    thank_you_url: input.thankYouUrl ?? "",
    unit_price: optionalPrice(input.unitPrice),
    webhook_url: input.webhookUrl ?? "",
  };
};

const buildUpdateBoolFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): Record<string, string> => ({
  assign_built_site: bool(
    pickField(updates.assignBuiltSite, existing.assign_built_site),
  ),
  can_pay_more: bool(pickField(updates.canPayMore, existing.can_pay_more)),
  hidden: bool(pickField(updates.hidden, existing.hidden)),
  non_transferable: bool(
    pickField(updates.nonTransferable, existing.non_transferable),
  ),
  purchase_only: bool(pickField(updates.purchaseOnly, existing.purchase_only)),
  uses_logistics: bool(
    pickField(updates.usesLogistics, existing.uses_logistics),
  ),
});

const buildUpdateNumericFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): Record<string, string> => {
  const assignsBuiltSite = pickField(
    updates.assignBuiltSite,
    existing.assign_built_site,
  );
  const initialSiteMonths = assignsBuiltSite
    ? pickField(updates.initialSiteMonths, existing.initial_site_months || 1)
    : pickField(updates.initialSiteMonths, existing.initial_site_months);
  return {
    duration_days: String(
      pickField(updates.durationDays, existing.duration_days),
    ),
    group_id: String(pickField(updates.groupId, existing.group_id)),
    initial_site_months: String(initialSiteMonths),
    max_attendees: String(
      pickField(updates.maxAttendees, existing.max_attendees),
    ),
    max_price: toMajorUnits(pickField(updates.maxPrice, existing.max_price)),
    max_quantity: String(pickField(updates.maxQuantity, existing.max_quantity)),
    maximum_days_after: String(
      pickField(updates.maximumDaysAfter, existing.maximum_days_after),
    ),
    minimum_days_before: String(
      pickField(updates.minimumDaysBefore, existing.minimum_days_before),
    ),
    months_per_unit: String(
      pickField(updates.monthsPerUnit, existing.months_per_unit),
    ),
    unit_price: formatPrice(updates.unitPrice, existing.unit_price),
  };
};

const buildUpdateStringFields = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): Record<string, string> => ({
  bookable_days: formatBookableDaysForForm(
    pickField(updates.bookableDays, existing.bookable_days),
  ),
  description: pickField(updates.description, existing.description),
  fields: pickField(updates.fields, existing.fields),
  listing_type: pickField(updates.listingType, existing.listing_type),
  location: pickField(updates.location, existing.location),
  name: pickField(updates.name, existing.name),
  slug: pickField(updates.slug, existing.slug),
  thank_you_url: formatOptional(updates.thankYouUrl, existing.thank_you_url),
  webhook_url: formatOptional(updates.webhookUrl, existing.webhook_url),
});

const buildUpdateListingForm = (
  updates: Partial<ListingInput>,
  existing: ListingWithCount,
): Record<string, string> => {
  const closesAtParts = splitClosesAt(updates.closesAt, existing.closes_at);
  const dateParts = splitClosesAt(updates.date, existing.date);
  return {
    ...buildUpdateBoolFields(updates, existing),
    ...buildUpdateNumericFields(updates, existing),
    ...buildUpdateStringFields(updates, existing),
    ...dayPriceFormFields(updates.dayPrices ?? existing.day_prices),
    closes_at_date: closesAtParts.date,
    closes_at_time: closesAtParts.time,
    customisable_days: bool(
      updates.customisableDays ?? existing.customisable_days,
    ),
    date_date: dateParts.date,
    date_time: dateParts.time,
  };
};

const formatOptional = (update: string | undefined, existing: string): string =>
  update ?? existing;

const formatPrice = (update: number | undefined, existing: number): string =>
  update !== undefined ? toMajorUnits(update) : toMajorUnits(existing);

async function doAuthenticatedRequest<T>(
  path: string,
  formData: Record<string, string>,
  buildRequest: (
    path: string,
    data: Record<string, string>,
    cookie: string,
  ) => Request,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> {
  const { getTestSession } = await import("#test-utils/session.ts");
  const { handleRequest } = await import("#routes");
  const session = await getTestSession();
  const response = await handleRequest(
    buildRequest(
      path,
      { ...formData, csrf_token: session.csrfToken },
      session.cookie,
    ),
  );
  if (response.status !== 302) {
    throw new Error(`Failed to ${errorContext}: ${response.status}`);
  }
  return onSuccess();
}

const doAuthenticatedFormRequest = async <T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> => {
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  return doAuthenticatedRequest(
    path,
    formData,
    mockFormRequest,
    onSuccess,
    errorContext,
  );
};

const doAuthenticatedMultipartFormRequest = async <T>(
  path: string,
  formData: Record<string, string>,
  onSuccess: () => Promise<T>,
  errorContext: string,
): Promise<T> => {
  const { mockMultipartRequest } = await import("#test-utils/mocks.ts");
  return doAuthenticatedRequest(
    path,
    formData,
    mockMultipartRequest,
    onSuccess,
    errorContext,
  );
};

export const createTestListing = (
  overrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
): Promise<Listing> => {
  const input = testListingInput(overrides);
  return doAuthenticatedMultipartFormRequest(
    "/admin/listing",
    buildCreateListingForm(input),
    async () => {
      const { getAllListings } = await import("#shared/db/listings.ts");
      const listings = await getAllListings();
      return listings[0] as Listing;
    },
    "create listing",
  );
};

const allDays: string[] = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

export const priceFormValue = (minorUnits: number): string =>
  toMajorUnits(minorUnits);

export const updateTestListing = async (
  listingId: number,
  updates: Partial<ListingInput>,
): Promise<Listing> => {
  const existing = await getListingWithCount(listingId);
  if (!existing) {
    throw new Error(`Listing not found: ${listingId}`);
  }
  return doAuthenticatedMultipartFormRequest(
    `/admin/listing/${listingId}/edit`,
    buildUpdateListingForm(updates, existing),
    async () => (await getListingWithCount(listingId)) as ListingWithCount,
    "update listing",
  );
};

const changeListingStatus =
  (action: "deactivate" | "reactivate") =>
  async (listingId: number): Promise<void> => {
    const listing = await getListingWithCount(listingId);
    if (!listing) {
      throw new Error(`Listing not found: ${listingId}`);
    }
    return doAuthenticatedFormRequest(
      `/admin/listing/${listingId}/${action}`,
      { confirm_identifier: listing.name },
      async () => {},
      `${action} listing`,
    );
  };

export const deactivateTestListing = changeListingStatus("deactivate");
export const reactivateTestListing = changeListingStatus("reactivate");

export const createTestAttendee = async (
  listingId: number,
  listingSlug: string,
  name: string,
  email: string,
  quantity = 1,
  phone = "",
): Promise<Attendee> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest, mockTicketFormRequest } = await import(
    "#test-utils/mocks.ts"
  );
  const { extractCsrfToken } = await import("#test-utils/csrf.ts");

  const pageResponse = await handleRequest(
    mockRequest(`/ticket/${listingSlug}`),
  );
  const pageHtml = await pageResponse.text();
  const csrfToken = extractCsrfToken(pageHtml) ?? (await signCsrfToken());

  const response = await handleRequest(
    mockTicketFormRequest(
      listingSlug,
      { email, name, phone, [`quantity_${listingId}`]: String(quantity) },
      csrfToken,
    ),
  );

  if (response.status !== 302 && response.status !== 303) {
    const body = await response.text();
    throw new Error(
      `Failed to create attendee: ${response.status} - ${body.slice(0, 200)}`,
    );
  }

  const flashCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("flash_"));
  if (flashCookie) {
    const cookiePart = flashCookie.split(";")[0]!;
    const value = cookiePart.split("=").slice(1).join("=");
    const parsed = parseFlashValue(value);
    if (parsed.error) {
      throw new Error(`Failed to create attendee: ${parsed.error}`);
    }
  }

  const afterAttendees = await getAttendeesRaw(listingId);
  return afterAttendees[0] as Attendee;
};

export { getAttendeesRaw };

/** Create a listing (maxAttendees 100) + attendee ("Cust" / "c@example.com")
 *  and assign logistics agents to its single booking line. The `assignments`
 *  callback receives the listing ID so the caller can key the map correctly
 *  without having to create the listing itself first. Shared by the
 *  logistics-runsheet and server-logistics test suites. */
export const createListingWithAttendeeAndLogistics = async (
  assignments: (listingId: number) => Map<number, LogisticsAssignment>,
): Promise<{ attendeeId: number; listingId: number }> => {
  const listing = await createTestListing({ maxAttendees: 100 });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Cust",
    "c@example.com",
  );
  await setLogisticsAssignments(attendee.id, false, assignments(listing.id));
  return { attendeeId: attendee.id, listingId: listing.id };
};

/** Register the standard processed-payments attenddee fixture: one listing +
 *  one attendee ("Test User" / "test@example.com") created in `beforeEach`,
 *  returning a holder whose `.attendeeId` is the current test's attendee id.
 *  Used by the locking and staleness test suites that share this exact setup. */
export const useProcessedPaymentsAttendee = (): { attendeeId: number } => {
  const holder = { attendeeId: 0 as number };
  beforeEach(async () => {
    const listing = await createTestListing();
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Test User",
      "test@example.com",
    );
    holder.attendeeId = attendee.id;
  });
  return holder;
};

/** Insert an attendee with no listing booking (an orphan) created `daysAgo`
 *  ago. Returns its numeric id. The `tokenPrefix` distinguishes orphans from
 *  different test suites — `priv-orphan-…` for privacy, `sched-orphan-…` for
 *  scheduled, `prune-orphan-…` for prune — so the ticket_token_index is
 *  unique even when two suites insert orphans against the same test DB. */
export const insertOrphanAttendee = async (
  daysAgo: number,
  tokenPrefix: string,
): Promise<number> => {
  const { getDb, insert } = await import("#shared/db/client.ts");
  const { nowMs } = await import("#shared/now.ts");
  const dayMs = 24 * 60 * 60 * 1000;
  const created = new Date(nowMs() - daysAgo * dayMs).toISOString();
  const result = await getDb().execute(
    insert("attendees", {
      created,
      pii_blob: "",
      ticket_token_index: `${tokenPrefix}-${crypto.randomUUID()}`,
    }) as never,
  );
  return Number(result.lastInsertRowid);
};

/** Check whether an attendee row exists by id. Returns true when the row is
 *  present, false when it has been purged. */
export const attendeeExists = async (id: number): Promise<boolean> => {
  const { queryOne } = await import("#shared/db/client.ts");
  return (
    (await queryOne<{ one: number }>(
      "SELECT 1 AS one FROM attendees WHERE id = ?",
      [id],
    )) !== null
  );
};

export const createTestAttendeeDirect = async (
  listingId: number,
  name: string,
  email: string,
  quantity = 1,
  phone = "",
  address = "",
  special_instructions = "",
): Promise<{ attendee: Attendee; token: string }> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");

  const result = await createAttendeeAtomic({
    address,
    bookings: [{ listingId, quantity }],
    email,
    name,
    phone,
    special_instructions,
  });

  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }

  return {
    attendee: result.attendees[0]!,
    token: result.attendees[0]!.ticket_token,
  };
};

/**
 * Build form data for the unified attendee edit form (`POST /admin/attendees/:id`).
 *
 * Emits the shared `start_date` + `day_count` (seeded from the attendee's
 * existing bookings) and one `qty_<listingId>` / `line_key_<listingId>` pair per
 * existing booking, so a bare call preserves the attendee unchanged. Pass
 * `overrides.lines` to set the full booked set (each `{ eventId, quantity, key }`
 * — quantity 0 or an omitted listing un-books it), or `startDate` / `dayCount`
 * to move the shared range.
 */
export const buildAttendeeEditForm = async (
  attendeeId: number,
  overrides: {
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
    special_instructions?: string;
    returnUrl?: string;
    startDate?: string;
    dayCount?: number;
    lines?: Array<{
      eventId: number;
      quantity?: number;
      /** Omit to book as a new line; pass the existing key to keep/move it. */
      key?: string;
    }>;
    /** Extra fields to merge in (e.g. `question_<id>`). */
    extra?: Record<string, string>;
  } = {},
): Promise<Record<string, string>> => {
  const { loadExistingLines } = await import("#shared/db/attendees.ts");
  const { resolveSharedDates } = await import(
    "#routes/admin/attendee-form-model.ts"
  );
  const existing = await loadExistingLines(attendeeId);
  const shared = resolveSharedDates(existing.map((e) => e.booking));
  const lines =
    overrides.lines ??
    existing.map(({ key, booking }) => ({
      eventId: booking.listing_id,
      key,
      quantity: booking.quantity,
    }));
  const form: Record<string, string> = {
    address: overrides.address ?? "",
    day_count: String(overrides.dayCount ?? shared.dayCount),
    email: overrides.email ?? "",
    name: overrides.name ?? "",
    phone: overrides.phone ?? "",
    special_instructions: overrides.special_instructions ?? "",
    start_date: overrides.startDate ?? shared.startDate,
  };
  if (overrides.returnUrl) form.return_url = overrides.returnUrl;
  for (const line of lines) {
    form[`qty_${line.eventId}`] = String(line.quantity ?? 1);
    form[`line_key_${line.eventId}`] = line.key ?? "";
  }
  if (overrides.extra) Object.assign(form, overrides.extra);
  return form;
};

export const createTestAttendeeWithToken = async (
  name: string,
  email: string,
  listingOverrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
  quantity = 1,
  phone = "",
): Promise<{ listing: Listing; attendee: Attendee; token: string }> => {
  const listing = await createTestListing({
    maxAttendees: 10,
    ...listingOverrides,
  });
  const { attendee, token } = await createTestAttendeeDirect(
    listing.id,
    name,
    email,
    quantity,
    phone,
  );
  return { attendee, listing, token };
};

export const createDailyTestListing = (
  overrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
) =>
  createTestListing({
    bookableDays: allDays,
    listingType: "daily",
    maxAttendees: 10,
    maximumDaysAfter: 60,
    minimumDaysBefore: 0,
    ...overrides,
  });

/**
 * Create a paid attendee (a payment_id + booking) WITHOUT posting any ledger
 * sale — a booking that predates the transfers ledger. A refund of it finds no
 * clean order to reverse, so `recordAttendeeRefund` reports `posted:false`; use
 * this to drive the "provider refunded but the ledger couldn't record it" paths.
 */
export const createPaidAttendeeWithoutLedger = async (
  listingId: number,
  name: string,
  email: string,
  paymentId: string,
  pricePaid = 500,
  quantity = 1,
): Promise<Attendee> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
  const result = await createAttendeeAtomic({
    bookings: [{ listingId, pricePaid, quantity }],
    email,
    name,
    paymentId,
  });
  return (result as { success: true; attendees: Attendee[] }).attendees[0]!;
};

export const createPaidTestAttendee = async (
  listingId: number,
  name: string,
  email: string,
  paymentId: string,
  pricePaid = 500,
  quantity = 1,
): Promise<Attendee> => {
  const attendee = await createPaidAttendeeWithoutLedger(
    listingId,
    name,
    email,
    paymentId,
    pricePaid,
    quantity,
  );
  // A paid attendee recognises gross revenue: post the sale leg so the
  // ledger-projected listing income reflects it (the price_paid column alone no
  // longer feeds income). A free (pricePaid 0) attendee posts nothing.
  if (pricePaid > 0) {
    const { postListingSale } = await import("#test-utils/ledger.ts");
    await postListingSale({
      attendeeId: attendee.id,
      gross: pricePaid,
      listingId,
    });
  }
  return attendee;
};

export const bookAttendee = async (
  listing: Pick<Listing, "id">,
  opts: BookAttendeeOpts = {},
): Promise<CreateAttendeeResult> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
  const booking: import("#shared/db/attendee-types.ts").ListingBooking = {
    listingId: listing.id,
  };
  if (opts.date !== undefined) booking.date = opts.date;
  if (opts.quantity !== undefined) booking.quantity = opts.quantity;
  if (opts.pricePaid !== undefined) booking.pricePaid = opts.pricePaid;
  if (opts.durationDays !== undefined) booking.durationDays = opts.durationDays;
  const result = await createAttendeeAtomic({
    bookings: [booking],
    email: opts.email ?? "x@example.com",
    name: opts.name ?? "X",
    ...(opts.phone !== undefined && { phone: opts.phone }),
    ...(opts.address !== undefined && { address: opts.address }),
    ...(opts.special_instructions !== undefined && {
      special_instructions: opts.special_instructions,
    }),
    ...(opts.paymentId !== undefined && { paymentId: opts.paymentId }),
  });
  // Mirror the live paid-checkout flow: a paid booking recognises gross revenue
  // with a ledger sale leg (which the per-row amount-paid projection reads), so a
  // bare price_paid no longer means anything on its own.
  if (result.success && opts.pricePaid && opts.pricePaid > 0) {
    const { postListingSale } = await import("#test-utils/ledger.ts");
    await postListingSale({
      attendeeId: result.attendees[0]!.id,
      gross: opts.pricePaid,
      listingId: listing.id,
    });
  }
  return result;
};

export const createDailyTestAttendee = async (
  name: string,
  email: string,
  date: string,
  listingOverrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
): Promise<{ listing: Listing; attendee: Attendee; token: string }> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
  const listing = await createDailyTestListing(listingOverrides);
  const result = await createAttendeeAtomic({
    bookings: [{ date, listingId: listing.id }],
    email,
    name,
  });
  const { attendees } = result as Extract<typeof result, { success: true }>;
  const attendee = attendees[0]!;
  return { attendee, listing, token: attendee.ticket_token };
};

export const createTestGroup = async (
  overrides: Partial<Omit<GroupInput, "slugIndex">> = {},
): Promise<Group> => {
  const input = {
    description: overrides.description ?? "",
    hidden: overrides.hidden ?? false,
    maxAttendees: overrides.maxAttendees ?? 0,
    name: overrides.name ?? "Test Group",
    termsAndConditions: overrides.termsAndConditions ?? "",
  };

  const group = await doAuthenticatedFormRequest(
    "/admin/groups",
    {
      description: input.description,
      max_attendees: String(input.maxAttendees),
      name: input.name,
      terms_and_conditions: input.termsAndConditions,
      ...(input.hidden ? { hidden: "1" } : {}),
    },
    async () => {
      const { getAllGroups } = await import("#shared/db/groups.ts");
      const groups = await getAllGroups();
      return groups[groups.length - 1] as Group;
    },
    "create group",
  );

  if (overrides.slug) {
    return updateTestGroup(group.id, {
      description: group.description,
      hidden: group.hidden,
      maxAttendees: group.max_attendees,
      name: group.name,
      slug: overrides.slug,
      termsAndConditions: group.terms_and_conditions,
    });
  }

  return group;
};

export const updateTestGroup = async (
  groupId: number,
  updates: Partial<Omit<GroupInput, "slugIndex">>,
): Promise<Group> => {
  const { groupsTable } = await import("#shared/db/groups.ts");
  const existing = (await groupsTable.findById(groupId)) as Group;

  const hidden = updates.hidden ?? existing.hidden;
  return doAuthenticatedFormRequest(
    `/admin/groups/${groupId}/edit`,
    {
      description: updates.description ?? existing.description,
      max_attendees: String(updates.maxAttendees ?? existing.max_attendees),
      name: updates.name ?? existing.name,
      slug: updates.slug ?? existing.slug,
      terms_and_conditions:
        updates.termsAndConditions ?? existing.terms_and_conditions,
      ...(hidden ? { hidden: "1" } : {}),
    },
    async () => {
      const updated = await groupsTable.findById(groupId);
      return updated as Group;
    },
    "update group",
  );
};

export const deleteTestGroup = async (groupId: number): Promise<void> => {
  const { groupsTable } = await import("#shared/db/groups.ts");
  const existing = (await groupsTable.findById(groupId)) as Group;

  return doAuthenticatedFormRequest(
    `/admin/groups/${groupId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete group",
  );
};

export const createTestHoliday = (
  overrides: Partial<HolidayInput> = {},
): Promise<Holiday> => {
  const input: HolidayInput = {
    endDate: overrides.endDate ?? "2026-12-25",
    name: overrides.name ?? "Test Holiday",
    startDate: overrides.startDate ?? "2026-12-25",
  };

  return doAuthenticatedFormRequest(
    "/admin/holidays",
    {
      end_date: input.endDate,
      name: input.name,
      start_date: input.startDate,
    },
    async () => {
      const { getAllHolidays } = await import("#shared/db/holidays.ts");
      const holidays = await getAllHolidays();
      return holidays[holidays.length - 1] as Holiday;
    },
    "create holiday",
  );
};

export const updateTestHoliday = async (
  holidayId: number,
  updates: Partial<HolidayInput>,
): Promise<Holiday> => {
  const { holidaysTable } = await import("#shared/db/holidays.ts");
  const existing = (await holidaysTable.findById(holidayId)) as Holiday;

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/edit`,
    {
      end_date: updates.endDate ?? existing.end_date,
      name: updates.name ?? existing.name,
      start_date: updates.startDate ?? existing.start_date,
    },
    async () => {
      const updated = await holidaysTable.findById(holidayId);
      return updated as Holiday;
    },
    "update holiday",
  );
};

export const deleteTestHoliday = async (holidayId: number): Promise<void> => {
  const { holidaysTable } = await import("#shared/db/holidays.ts");
  const existing = (await holidaysTable.findById(holidayId)) as Holiday;

  return doAuthenticatedFormRequest(
    `/admin/holidays/${holidayId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete holiday",
  );
};

/**
 * Provision a test built site for renewals: writes a fresh token + HMAC index
 * directly via updateBuiltSiteRenewalState. Skips the admin route intentionally
 * — admin-route coverage lives in test/admin-built-sites-actions.test.ts.
 */
export const provisionTestBuiltSite = async (
  siteId: number,
  opts: { readOnlyFrom?: string } = {},
): Promise<{ token: string; tokenIndex: string }> => {
  const { generateRenewalToken } = await import("#shared/site-assignment.ts");
  const { updateBuiltSiteRenewalState } = await import(
    "#shared/db/built-sites.ts"
  );
  const { index, token } = await generateRenewalToken();
  await updateBuiltSiteRenewalState(siteId, {
    renewalToken: token,
    renewalTokenIndex: index,
    ...(opts.readOnlyFrom !== undefined
      ? { readOnlyFrom: opts.readOnlyFrom }
      : {}),
  });
  return { token, tokenIndex: index };
};

export const createTestBuiltSite = (
  overrides: Partial<BuiltSiteFormInput> = {},
): Promise<import("#shared/db/built-sites.ts").BuiltSite> => {
  const dbProvider = overrides.dbProvider ?? "bunny";
  const hostingProvider = overrides.hostingProvider ?? "bunny";
  const input: BuiltSiteFormInput = {
    assignable: overrides.assignable ?? false,
    dbProvider,
    dbToken: overrides.dbToken ?? "",
    dbUrl: overrides.dbUrl ?? "",
    hostingId: overrides.hostingId ?? "",
    hostingProvider,
    name: overrides.name ?? "Test Site",
    siteUrl: overrides.siteUrl ?? "https://test.b-cdn.net",
    ...(overrides.updates ? { updates: overrides.updates } : {}),
  };

  return doAuthenticatedFormRequest(
    "/admin/built-sites",
    {
      db_provider: dbProvider,
      db_token: input.dbToken,
      db_url: input.dbUrl,
      hosting_id: input.hostingId,
      hosting_provider: hostingProvider,
      name: input.name,
      site_url: input.siteUrl,
      ...(input.assignable ? { assignable: "1" } : {}),
      ...(input.updates ? { updates: input.updates } : {}),
    },
    async () => {
      const { getAllBuiltSites } = await import("#shared/db/built-sites.ts");
      const sites = await getAllBuiltSites();
      return sites[
        sites.length - 1
      ] as import("#shared/db/built-sites.ts").BuiltSite;
    },
    "create built site",
  );
};

export const updateTestBuiltSite = async (
  siteId: number,
  updates: Partial<BuiltSiteFormInput>,
): Promise<import("#shared/db/built-sites.ts").BuiltSite> => {
  const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
  const existing = (await builtSitesCrudTable.findById(
    siteId,
  )) as import("#shared/db/built-sites.ts").BuiltSite;

  const assignable = updates.assignable ?? existing.assignable;
  return doAuthenticatedFormRequest(
    `/admin/built-sites/${siteId}/edit`,
    {
      db_token: updates.dbToken ?? existing.dbToken,
      db_url: updates.dbUrl ?? existing.dbUrl,
      hosting_id: updates.hostingId ?? existing.hostingId,
      name: updates.name ?? existing.name,
      site_url: updates.siteUrl ?? existing.siteUrl,
      updates: updates.updates ?? existing.updates,
      ...(assignable ? { assignable: "1" } : {}),
    },
    async () => {
      const updated = await builtSitesCrudTable.findById(siteId);
      return updated as import("#shared/db/built-sites.ts").BuiltSite;
    },
    "update built site",
  );
};

export const deleteTestBuiltSite = async (siteId: number): Promise<void> => {
  const { builtSitesCrudTable } = await import("#shared/db/built-sites.ts");
  const existing = (await builtSitesCrudTable.findById(
    siteId,
  )) as import("#shared/db/built-sites.ts").BuiltSite;

  return doAuthenticatedFormRequest(
    `/admin/built-sites/${siteId}/delete`,
    { confirm_identifier: existing.name },
    async () => {},
    "delete built site",
  );
};

export const createTestInvite = async (
  username: string,
  adminLevel = "manager",
): Promise<{ inviteCode: string; cookie: string; csrfToken: string }> => {
  const { getTestSession } = await import("#test-utils/session.ts");
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const { cookie, csrfToken } = await getTestSession();
  const inviteResponse = await handleRequest(
    mockFormRequest(
      "/admin/users",
      { admin_level: adminLevel, csrf_token: csrfToken, username },
      cookie,
    ),
  );
  const location = inviteResponse.headers.get("location") ?? "";
  const url = new URL(location, "http://localhost");
  const inviteLink = url.searchParams.get("invite") ?? "";
  const codeMatch = inviteLink.match(/\/join\/([A-Za-z0-9_-]+)/);
  if (!codeMatch?.[1]) {
    throw new Error(
      `Failed to create invite for ${username}: ${inviteResponse.status} ${location}`,
    );
  }
  return { cookie, csrfToken, inviteCode: codeMatch[1] };
};

export const getEmbeddableTicketResponse = async (): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const listing = await createTestListing({
    maxAttendees: 50,
    thankYouUrl: "https://example.com",
  });
  return handleRequest(mockRequest(`/ticket/${listing.slug}`));
};

export const decryptFirstAttendee = async (
  listingId: number,
): Promise<Attendee> => {
  const privateKey = await getTestPrivateKey();
  const raw = await getAttendeesRaw(listingId);
  const attendees = await decryptAttendees(raw, privateKey);
  expect(attendees.length).toBe(1);
  return attendees[0]!;
};
