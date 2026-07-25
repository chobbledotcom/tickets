import { expect } from "@std/expect";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { parseFlashValue } from "#shared/cookies.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import type { ExistingLine } from "#shared/db/attendees/atomic-update.ts";
import { decryptAttendees } from "#shared/db/attendees/pii.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { createDailyTestListing, createTestListing } from "./listings.ts";

export { getAttendeesRaw };

export const expectNoAttendeesForListings = async (
  listingIds: number[],
): Promise<void> => {
  for (const listingId of listingIds) {
    expect(await getAttendeesRaw(listingId)).toEqual([]);
  }
};

/** Book a test attendee onto the given listing(s) directly via the DB,
 *  bypassing the booking routes. Shared by unit tests that just need an
 *  attendee to hang bookings or answers off. */
export const bookTestAttendee = async (
  listingIds: number[],
  name = "Alice",
  email?: string,
): Promise<Attendee> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: listingIds.map((listingId) => ({ listingId })),
    email: email ?? `${name.toLowerCase()}@test.com`,
    name,
    source: "public",
  });
  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }
  return result.attendees[0]!;
};

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
  const result = await attendeesApi.createAttendeeAtomic({
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

  const attendee = result.attendees[0]!;
  const { logActivity } = await import("#shared/db/activityLog.ts");
  await logActivity(`Attendee '${name}' created`, listingId, attendee.id);

  return {
    attendee,
    token: attendee.ticket_token,
  };
};

/**
 * Build form data for the unified attendee edit form (`POST /admin/attendees/:id`).
 *
 * Emits the shared `start_date` + `day_count` (seeded from the attendee's
 * existing bookings) and one indexed editor line (`line_listing_<i>` +
 * `qty_<i>` + `line_key_<i>`) per existing booking ROW — every path the
 * attendee books through — so a bare call preserves the attendee unchanged.
 * Pass `overrides.lines` to set the full line set (each
 * `{ eventId, quantity, key, packageGroupId }` — quantity 0 or an omitted row
 * un-books it; `packageGroupId` books a NEW line through that package), or
 * `startDate` / `dayCount` to move the shared range.
 */
/** One editor line for {@link attendeeLineFields}. */
export type AttendeeLineInput = {
  eventId: number;
  quantity?: number;
  /** Omit to book as a new line; pass the existing key to keep/move it. */
  key?: string;
  /** The package path a NEW line books through (existing rows carry
   * their own). */
  packageGroupId?: number;
  /** Tick the line's "no quantity" box. */
  noQuantity?: boolean;
};

const attendeeLineInput = ({
  key,
  booking,
}: ExistingLine): AttendeeLineInput => ({
  eventId: booking.listing_id,
  key,
  noQuantity: booking.quantity === 0,
  packageGroupId: 0,
  quantity: booking.quantity,
});

export const existingAttendeeLines = async (
  attendeeId: number,
): Promise<AttendeeLineInput[]> => {
  const { loadExistingLines } = await import(
    "#shared/db/attendees/atomic-update.ts"
  );
  return (await loadExistingLines(attendeeId)).map(attendeeLineInput);
};

/** The indexed editor-line fields (`line_listing_<i>` + `qty_<i>` + …) for a
 * set of lines — the admin attendee form's wire shape. Spread into a POST
 * body: `{ name: "X", ...attendeeLineFields([{ eventId: 5, quantity: 1 }]) }`. */
export const attendeeLineFields = (
  lines: AttendeeLineInput[],
): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const [index, line] of lines.entries()) {
    fields[`line_listing_${index}`] = String(line.eventId);
    fields[`qty_${index}`] = String(line.quantity ?? 1);
    fields[`line_key_${index}`] = line.key ?? "";
    if (line.noQuantity) fields[`noqty_${index}`] = "1";
    if ((line.packageGroupId ?? 0) > 0 && !line.key) {
      fields[`line_package_${index}`] = String(line.packageGroupId);
    }
  }
  return fields;
};

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
    lines?: AttendeeLineInput[];
    /** Extra fields to merge in (e.g. `question_<id>`). */
    extra?: Record<string, string>;
  } = {},
): Promise<Record<string, string>> => {
  const { resolveSharedDates } = await import(
    "#routes/admin/attendee-form-model.ts"
  );
  const { loadExistingLines } = await import(
    "#shared/db/attendees/atomic-update.ts"
  );
  const existing = await loadExistingLines(attendeeId);
  const shared = resolveSharedDates(existing.map(({ booking }) => booking));
  const lines = overrides.lines ?? existing.map(attendeeLineInput);
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
  Object.assign(form, attendeeLineFields(lines));
  if (overrides.extra) Object.assign(form, overrides.extra);
  return form;
};

export const submitAttendeeEdit = async (
  attendeeId: number,
  overrides: Parameters<typeof buildAttendeeEditForm>[1],
): Promise<Response> => {
  const { adminFormPost } = await import("#test-utils/session.ts");
  const form = await buildAttendeeEditForm(attendeeId, overrides);
  return (await adminFormPost(`/admin/attendees/${attendeeId}`, form)).response;
};

/** Create one attendee booked across several listings in a single order —
 *  one booking line per listing, each with its own quantity (default 1).
 *  Used by the grouped attendee-table suites. */
export const createMultiBookingAttendee = async (
  name: string,
  email: string,
  bookings: Array<{ listingId: number; quantity?: number }>,
): Promise<Attendee> => {
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: bookings.map((booking) => ({
      listingId: booking.listingId,
      quantity: booking.quantity ?? 1,
    })),
    email,
    name,
  });
  // Callers pass listings with capacity, so the booking always succeeds; cast
  // the union rather than guard, mirroring createPaidAttendeeWithoutLedger (a
  // never-taken failure branch would be an uncovered line).
  return (result as { success: true; attendees: Attendee[] }).attendees[0]!;
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

/** Create a test attendee for "Alice" and fetch her ticket page body.
 *  Returns both the token (for further URL assertions) and the HTML body. */
export const fetchAliceTicketPageBody = async (): Promise<{
  token: string;
  body: string;
}> => {
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  const { token } = await createTestAttendeeWithToken(
    "Alice",
    "alice@test.com",
  );
  const response = await awaitTestRequest(`/t/${token}`);
  const body = await response.text();
  return { body, token };
};

export const createDailyTestAttendee = async (
  name: string,
  email: string,
  date: string,
  listingOverrides: Partial<Omit<ListingInput, "slug" | "slugIndex">> = {},
): Promise<{ listing: Listing; attendee: Attendee; token: string }> => {
  const listing = await createDailyTestListing(listingOverrides);
  const result = await attendeesApi.createAttendeeAtomic({
    bookings: [{ date, listingId: listing.id }],
    email,
    name,
  });
  const { attendees } = result as Extract<typeof result, { success: true }>;
  const attendee = attendees[0]!;
  return { attendee, listing, token: attendee.ticket_token };
};

/** Assert a listing decrypts to no attendees at all — used both for a
 *  freshly created listing and after deleting one that had attendees. */
export const expectNoDecryptedAttendees = async (
  listingId: number,
): Promise<void> => {
  const privateKey = await getTestPrivateKey();
  const raw = await getAttendeesRaw(listingId);
  const attendees = await decryptAttendees(raw, privateKey);
  expect(attendees).toEqual([]);
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
