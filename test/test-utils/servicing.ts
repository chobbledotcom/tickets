/**
 * Shared helpers for the servicing-events test suite.
 *
 * The canonical patterns repeated across `test/lib/servicing/*.test.ts` — the
 * "create a listing + servicing hold" fixture, the "render an admin page as
 * the logged-in owner" dance, the small DB query helpers (`kindOf`,
 * `tokenIndexOf`, `attendeeExists`, `childRowCount`), the "decrypt the first
 * attendee row for a listing" projection, the "assert every contact field is
 * empty" assertion, and the e2e "find the servicing link on the page" lookup —
 * live here so each test file asserts behaviour rather than restating setup.
 *
 * The test-utils path is on jscpd's ignore list, so the helpers themselves
 * don't trip the 0% duplication threshold; the test files call them by name.
 *
 * Production API surface these helpers delegate to (`createServicingEvent`,
 * `deleteServicingEvent`, `updateServicingEvent`, `duplicateServicingEvent`,
 * `getServicingEvent`, `recordServiceCost`, `editServiceCost`, `costOf`,
 * `profitOf`, `costAccount`) — defined by `src/shared/db/attendees/servicing.ts`
 * and `src/shared/accounting/*`; see each test file's header for the contract.
 */

import { expect } from "@std/expect";
import type { ListingBooking } from "#shared/db/attendee-types.ts";
import { SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import { ATTENDEE_JOIN_SELECT } from "#shared/db/attendees.ts";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { getAllListings } from "#shared/db/listings.ts";
import type { Attendee, Listing, ListingWithCount } from "#shared/types.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { createTestListing } from "#test-utils/db-helpers.ts";
import { getTestSession, withTestSession } from "#test-utils/session.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

// ─── Production API re-exports (see contract above) ────────────────────────

import {
  buildDuplicateServicingInput,
  createServicingEvent as createServicingEventImpl,
  deleteServicingEvent as deleteServicingEventImpl,
  duplicateServicingEvent as duplicateServicingEventImpl,
  editServiceCost,
  getServicingEvent as getServicingEventImpl,
  recordServiceCost,
  type ServicingEvent,
  type ServicingEventInput,
  updateServicingEvent as updateServicingEventImpl,
} from "#shared/db/attendees/servicing.ts";

export type { ServicingEvent, ServicingEventInput };
export { buildDuplicateServicingInput, editServiceCost, recordServiceCost };

export const createServicingEvent = (
  input: ServicingEventInput,
): Promise<ServicingEvent> =>
  withTestSession(() => createServicingEventImpl(input));

export const updateServicingEvent = (
  id: number,
  input: ServicingEventInput,
): Promise<ServicingEvent> =>
  withTestSession(() => updateServicingEventImpl(id, input));

export const getServicingEvent = (id: number): Promise<ServicingEvent | null> =>
  withTestSession(() => getServicingEventImpl(id));

export const deleteServicingEvent = (id: number): Promise<void> =>
  withTestSession(() => deleteServicingEventImpl(id));

export const duplicateServicingEvent = (id: number): Promise<ServicingEvent> =>
  withTestSession(() => duplicateServicingEventImpl(id));

// ─── Create helpers ─────────────────────────────────────────────────────────

/** Create a servicing hold through the real production path. */
export const createTestServicingEvent = (
  input: ServicingEventInput,
): Promise<ServicingEvent> => createServicingEvent(input);

type TestListingInput = Parameters<typeof createTestListing>[0];

const resolveTestListing = async (
  input: TestListingInput = {},
): Promise<Listing> => {
  const listingInput = input ?? {};
  const existingListings = await getAllListings();
  if (listingInput.name) {
    const existing = existingListings.find(
      (listing: ListingWithCount) => listing.name === listingInput.name,
    );
    if (existing) return existing;
  }
  if (existingListings.length === 1) return existingListings[0]!;
  return createTestListing(listingInput);
};

/** The canonical "one listing + one servicing hold on it" fixture. Returns
 *  the listing, the event, and the event's id + token for destructure-free
 *  use. `listingOverrides` default to `{ maxAttendees: 10 }`; `holdOverrides`
 *  default to a single `quantity: 1` booking on that listing named
 *  "Boiler Service". */
export const createServicingHold = async (
  opts: {
    listing?: Parameters<typeof createTestListing>[0];
    name?: string;
    quantity?: number;
    date?: string;
    durationDays?: number;
    allowOverbook?: boolean;
    questionAnswers?: ServicingEventInput["questionAnswers"];
  } = {},
): Promise<{
  event: ServicingEvent;
  id: number;
  listing: Listing;
  ticketToken: string;
}> => {
  const listing = await resolveTestListing({
    maxAttendees: 10,
    ...opts.listing,
  });
  const booking: ListingBooking = {
    listingId: listing.id,
    quantity: opts.quantity ?? 1,
  };
  if (opts.date !== undefined) booking.date = opts.date;
  if (opts.durationDays !== undefined) booking.durationDays = opts.durationDays;
  const event = await createTestServicingEvent({
    allowOverbook: opts.allowOverbook,
    bookings: [booking],
    name: opts.name ?? "Boiler Service",
    questionAnswers: opts.questionAnswers,
  });
  return { event, id: event.id, listing, ticketToken: event.ticketToken };
};

// ─── DB query helpers ───────────────────────────────────────────────────────

/** The `kind` column value for an attendee row, or null when the id is gone. */
export const kindOf = async (id: number): Promise<string | null> => {
  const row = await queryOne<{ kind: string }>(
    "SELECT kind FROM attendees WHERE id = ?",
    [id],
  );
  return row?.kind ?? null;
};

/** The `ticket_token_index` for an attendee row, or null when the id is gone. */
export const tokenIndexOf = async (id: number): Promise<string | null> => {
  const row = await queryOne<{ idx: string }>(
    "SELECT ticket_token_index AS idx FROM attendees WHERE id = ?",
    [id],
  );
  return row?.idx ?? null;
};

/** True when an attendee row with this id still exists. */
export const attendeeExists = async (id: number): Promise<boolean> => {
  const row = await queryOne<{ one: number }>(
    "SELECT 1 AS one FROM attendees WHERE id = ?",
    [id],
  );
  return row !== null;
};

/** Count rows in a child table referencing this attendee id. */
export const childRowCount = async (
  table: string,
  attendeeId: number,
): Promise<number> =>
  (
    await queryOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${table} WHERE attendee_id = ?`,
      [attendeeId],
    )
  )?.count ?? 0;

// ─── Decryption + assertion helpers ────────────────────────────────────────

export const servicingRowsForListing = (
  listingId: number,
): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${ATTENDEE_JOIN_SELECT}
       FROM attendees a
       JOIN listing_attendees ea ON ea.attendee_id = a.id
      WHERE ea.listing_id = ?
        AND a.kind = ?
      ORDER BY a.id`,
    [listingId, SERVICING_KIND],
  );

/** Decrypt the first attendee row booked against `listingId`. Used to assert
 *  on the stored PII shape (name / contact fields) of the listing's first
 *  booking — the shape a servicing event persists. */
export const decryptFirstAttendee = async (
  listingId: number,
): Promise<Attendee | null> => {
  const { decryptAttendeeOrNull } = await import("#shared/db/attendees.ts");
  const pk = await getTestPrivateKey();
  const rows = await servicingRowsForListing(listingId);
  return rows.length > 0 ? decryptAttendeeOrNull(rows[0]!, pk) : null;
};

/** Assert every customer-only contact field on a decrypted attendee is the
 *  empty/null/zero shape a servicing event persists (name is the only field
 *  set). Pins the §3/§19 "kind owns state, not the template" contract. */
export const expectEmptyContactFields = (a: Attendee | null): void => {
  expect(a).not.toBeNull();
  expect(a?.email).toBe("");
  expect(a?.phone).toBe("");
  expect(a?.address).toBe("");
  expect(a?.special_instructions).toBe("");
  expect(a?.status_id).toBeNull();
  expect(a?.remaining_balance).toBe(0);
};

/** A smuggle-attack form payload: every customer-only field set to a non-empty
 *  value, to prove the server normalises by kind regardless of the POST body. */
export const SMUGGLED_CONTACT_FIELDS = {
  address: "12 Sneaky Street",
  email: "smuggler@example.com",
  phone: "+44 7700 900000",
  remainingBalance: 9000,
  specialInstructions: "be quiet",
  statusId: 3,
} as const;

// ─── Admin page render helper ───────────────────────────────────────────────

/** Render an admin page as the logged-in test owner and return its HTML.
 *  Replaces the per-file `getTestSession` + `handleRequest` + `mockRequest`
 *  dance duplicated across §5/§6/§8/§11/§12/§17. */
export const renderAdminPage = async (path: string): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const { cookie } = await getTestSession();
  const response = await handleRequest(
    mockRequest(path, {
      headers: { cookie, host: "localhost" },
    } as RequestInit),
  );
  return response.text();
};

/** Assert an admin path returns 404 for the given session cookie. */
export const assertAdmin404 = async (
  path: string,
  cookie: string,
): Promise<void> => {
  const { awaitTestRequest } = await import("#test-utils/mocks.ts");
  const response = await awaitTestRequest(path, { cookie });
  expect(response.status).toBe(404);
  response.body?.cancel();
};

/** Assert rendered HTML links a servicing id to `/admin/servicing/:id` and NOT
 *  to `/admin/attendees/:id` — the kind-aware routing contract (§8/§12/§17). */
export const expectServicingLink = (body: string, id: number): void => {
  expect(body).toContain(`/admin/servicing/${id}`);
  expect(body).not.toContain(`/admin/attendees/${id}`);
};

/** POST an admin form as the logged-in test owner and return the response
 *  (for status/body assertions). Replaces the per-test `handleRequest` +
 *  `mockFormRequest` + `getTestSession` dance. */
export const adminPost = async (
  path: string,
  data: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const { cookie, csrfToken } = await getTestSession();
  return handleRequest(
    mockFormRequest(path, { csrf_token: csrfToken, ...data }, cookie),
  );
};

// ─── E2E helpers ────────────────────────────────────────────────────────────

/** The standard e2e setup: log in + create a daily "Room A" listing, ready for
 *  a servicing hold. Each §21 narrative opens with this exact sequence. */
export const setupBrowserWithListing = async (
  browser: TestBrowser,
  listingFields: Record<string, string> & { name: string },
): Promise<number> => {
  const { setupAndLogin, createListing } = await import("#test-utils/e2e.ts");
  await setupAndLogin(browser);
  return Number(await createListing(browser, listingFields));
};

/** The standard e2e "create a servicing hold" flow: visit the create form,
 *  fill in name + quantity on the created listing, submit. Used by every §21
 *  narrative scenario. */
export const createHoldInBrowser = async (
  browser: TestBrowser,
  name: string,
  listingId: number,
): Promise<void> => {
  await submitServicingCreateForm(browser, { listingId, name });
};

/** Find the first `/admin/servicing/:id` link on the current page. */
export const findServicingLink = (browser: TestBrowser): string => {
  const currentPath = browser.currentUrl.match(/^\/admin\/servicing\/\d+/)?.[0];
  if (currentPath) return currentPath;
  const link = browser.links.find((l) => l.href.includes("/admin/servicing/"));
  if (link) return link.href;
  const formAction = browser.currentHtml.match(
    /action="(\/admin\/servicing\/\d+)/,
  )?.[1];
  if (formAction) return formAction;
  throw new Error("no /admin/servicing/ link on the current page");
};

/** Submit the standard servicing create form: name + quantity on listing id
 *  `quantity_${listingId}` + a single-day `start_date`. Mirrors the operator
 *  narrative flow each §21 e2e scenario opens with. */
export const submitServicingCreateForm = async (
  browser: TestBrowser,
  fields: {
    name: string;
    listingId: number;
    quantity?: number;
    startDate?: string;
  },
): Promise<void> => {
  await browser.visit("/admin/servicing/new");
  await browser.submitForm(
    {
      day_count: "1",
      name: fields.name,
      [`quantity_${fields.listingId}`]: String(fields.quantity ?? 1),
      start_date: fields.startDate ?? "2099-07-01",
    },
    "Create Service Event",
  );
};

/** Build the booking-line shape a servicing event carries (mirror of
 *  `ListingBooking` so tests don't import the type ad hoc). */
export const servicingBooking = (
  listingId: number,
  quantity: number,
  date?: string,
): ListingBooking => {
  const booking: ListingBooking = { listingId, quantity };
  if (date !== undefined) booking.date = date;
  return booking;
};

// ─── Compound assertion helpers (curried where the shape is shared) ─────────

/** Assert a servicing event's logistics plan is disabled (split=0, no agents).
 *  The smuggle-attack guard in §3 and §19 both assert this exact shape. */
export const expectLogisticsDisabled = async (id: number): Promise<void> => {
  const row = await queryOne<{
    assigned: number;
    split: number;
  }>(
    `SELECT attendee.split_logistics_agents AS split,
            (
              SELECT COUNT(*) FROM listing_attendees AS booking
              WHERE booking.attendee_id = attendee.id
                AND (
                  booking.start_agent_id IS NOT NULL
                  OR booking.end_agent_id IS NOT NULL
                )
            ) AS assigned
       FROM attendees AS attendee
      WHERE attendee.id = ?`,
    [id],
  );
  expect(row?.split).toBe(0);
  expect(row?.assigned).toBe(0);
};

/** Record a cost against a servicing event and assert the listing's total cost
 *  projection reads the expected amount. The §22 ledger tests repeat this
 *  record-then-assert sequence for every "cost lands on the listing" check. */
export const expectCostAfterRecording = async (
  servicingId: number,
  listingId: number,
  amount: number,
  expectedTotal: number,
): Promise<void> => {
  const { recordServiceCost } = await import(
    "#shared/db/attendees/servicing.ts"
  );
  const { costOf } = await import("#shared/accounting/projection.ts");
  await recordServiceCost({
    amount,
    listingId,
    memo: "Boiler part",
    occurredAt: "2026-07-01T00:00:00.000Z",
    servicingId,
  });
  expect(await costOf(listingId)).toBe(expectedTotal);
};

/** Assert a promise rejects, optionally matching a pattern. The §14 validation
 *  and §22 allocation-rule tests both wrap `expect(...).rejects.toThrow()`. */
export const expectRejects = async (
  promise: Promise<unknown>,
  pattern?: RegExp,
): Promise<void> => {
  try {
    await promise;
  } catch (error) {
    if (pattern !== undefined) {
      expect((error as Error).message).toMatch(pattern);
    }
    return;
  }
  throw new Error("expected the promise to reject, but it resolved");
};

/** Create two daily listings — the multi-booking fixture shared by §3 (create),
 *  §4 (edit), and §18 (duplicate). */
export const createDailyListingPair = async (
  nameA: string,
  nameB: string,
  maxAttendees = 10,
): Promise<[Listing, Listing]> => {
  const { createDailyTestListing } = await import("#test-utils/db-helpers.ts");
  const a = await createDailyTestListing({ maxAttendees, name: nameA });
  const b = await createDailyTestListing({ maxAttendees, name: nameB });
  return [a, b];
};

/** The full e2e narrative opener: log in, create a listing, create a servicing
 *  hold on it. Every §21 scenario begins with this sequence. */
export const setupBrowserWithHold = async (
  browser: TestBrowser,
  listingFields: Record<string, string> & { name: string },
  holdName: string,
): Promise<void> => {
  const listingId = await setupBrowserWithListing(browser, listingFields);
  await createHoldInBrowser(browser, holdName, listingId);
};

// ─── Control-attendee fixture ───────────────────────────────────────────────

/** Create a listing + a real (customer) attendee on it — the control fixture
 *  every "servicing is excluded / 404s / can't be edited as attendee" test
 *  contrasts against. Mirrors `createServicingHold` for the customer side. */
export const createRealAttendee = async (
  name = "Real Customer",
  email = "real@example.com",
  listingOverrides: Parameters<typeof createTestListing>[0] = {},
): Promise<{
  attendee: import("#shared/types.ts").Attendee;
  listing: Listing;
}> => {
  const { createTestAttendeeDirect } = await import(
    "#test-utils/db-helpers.ts"
  );
  const listing = await resolveTestListing({
    maxAttendees: 10,
    name: "L",
    ...listingOverrides,
  });
  const { attendee } = await createTestAttendeeDirect(listing.id, name, email);
  return { attendee, listing };
};

// ─── Route-guard helper ─────────────────────────────────────────────────────

/** Assert that every customer (attendee) route for a servicing id returns 404.
 *  One call replaces the per-route `assertAdmin404` blocks in §9/§19. */
export const assertServicingId404sEverywhere = async (
  id: number,
  listingId: number,
): Promise<void> => {
  const { cookie } = await getTestSession();
  const actions = ["delete", "resend-notification", "checkin"];
  const paths = [
    `/admin/attendees/${id}`,
    `/admin/attendees/${id}/balance`,
    `/admin/attendees/${id}/merge`,
    `/admin/attendees/${id}/refresh-payment`,
    ...actions.map((a) => `/admin/listing/${listingId}/attendee/${id}/${a}`),
  ];
  for (const path of paths) {
    await assertAdmin404(path, cookie);
  }
};
