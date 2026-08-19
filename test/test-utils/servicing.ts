/**
 * Shared helpers for the servicing-events test suite.
 *
 * The canonical patterns repeated across `test/lib/servicing/*.test.ts` — the
 * "create a listing + servicing hold" fixture, the "render an admin page as
 * the logged-in owner" dance, the small DB query helpers (`kindOf`,
 * `tokenIndexOf`, `childRowCount`), the "decrypt the first servicing
 * attendee row for a listing" projection, the "assert every contact field is
 * empty" assertion, and the e2e "find the servicing link on the page" lookup —
 * live here so each test file asserts behaviour rather than restating setup.
 *
 * The test-utils path is on jscpd's ignore list, so the helpers themselves
 * don't trip the 0% duplication threshold; the test files call them by name.
 *
 * Production API surface these helpers delegate to (`createServicingEvent`,
 * `deleteServicingEvent`, `updateServicingEvent`, `duplicateServicingEvent`,
 * `getServicingEvent`, `recordServiceCost`, `editServiceCost`, and
 * `costAccount`) — defined by `src/shared/db/attendees/servicing.ts` and
 * `src/shared/accounting/*`; see each test file's header for the contract.
 */

import { expect } from "@std/expect";
import { costAccount } from "#accounting/accounts.ts";
import { accountBalance } from "#accounting/queries.ts";
import type { ListingBooking } from "#db/attendee-types.ts";
import { SERVICING_KIND } from "#db/attendees/kind.ts";
import { ATTENDEE_FIELDS, attendeeColumns } from "#db/attendees/select.ts";
import { getDb, queryAll, queryOne } from "#db/client.ts";
import { getAllListings } from "#db/listings/records.ts";
import { nowMs } from "#shared/now.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { getTestSession, withTestSession } from "#test-utils/session.ts";
import type { Attendee, Listing, ListingWithCount } from "#types";

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
} from "#db/attendees/servicing.ts";

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

/** The canonical "Annual Inspection" servicing event spanning two daily
 *  listings on consecutive days — quantity 2 on the first, 1 on the second.
 *  Used by the §3-creation and §18-duplicate tests (the duplicate test must
 *  start from an event whose bookings the duplicate reproduces 1-for-1),
 *  sharing the fixture so they cannot drift apart. */
export const createAnnualInspectionEvent = (
  a: Pick<Listing, "id">,
  b: Pick<Listing, "id">,
): Promise<ServicingEvent> =>
  createTestServicingEvent({
    bookings: [
      { date: "2026-07-01", listingId: a.id, quantity: 2 },
      { date: "2026-07-02", listingId: b.id, quantity: 1 },
    ],
    name: "Annual Inspection",
  });

type TestListingInput = Parameters<typeof createTestListing>[0];

const resolveTestListing = async (
  input: TestListingInput = {},
): Promise<Listing> => {
  const existingListings = await getAllListings();
  if (input.name) {
    const existing = existingListings.find(
      (listing: ListingWithCount) => listing.name === input.name,
    );
    if (existing) return existing;
  }
  if (existingListings.length === 1) return existingListings[0]!;
  return createTestListing(input);
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
    ...(opts.allowOverbook !== undefined
      ? { allowOverbook: opts.allowOverbook }
      : {}),
    bookings: [booking],
    name: opts.name ?? "Boiler Service",
    ...(opts.questionAnswers !== undefined
      ? { questionAnswers: opts.questionAnswers }
      : {}),
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

/** The `ticket_token_index` for an attendee row. */
export const tokenIndexOf = async (id: number): Promise<string> =>
  (await queryOne<{ idx: string }>(
    "SELECT ticket_token_index AS idx FROM attendees WHERE id = ?",
    [id],
  ))!.idx;

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp `days` days before now (for backdating past the purge cutoff). */
export const daysAgoIso = (days: number): string =>
  new Date(nowMs() - days * DAY_MS).toISOString();

/** Drop a servicing event's booking link and backdate its `created` by `daysAgo`
 *  days — the orphan state the purge sweeps. Shared by the deletion and
 *  purge-edge-case suites. */
export const orphanServicingEvent = async (
  id: number,
  daysAgo = 30,
): Promise<void> => {
  await getDb().execute({
    args: [id],
    sql: "DELETE FROM listing_attendees WHERE attendee_id = ?",
  });
  await getDb().execute({
    args: [daysAgoIso(daysAgo), id],
    sql: "UPDATE attendees SET created = ? WHERE id = ?",
  });
};

/** Count rows in a child table referencing this attendee id. */
export const childRowCount = async (
  table: string,
  attendeeId: number,
): Promise<number> =>
  (await queryOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${table} WHERE attendee_id = ?`,
    [attendeeId],
  ))!.count;

// ─── Decryption + assertion helpers ────────────────────────────────────────

export const servicingRowsForListing = (
  listingId: number,
): Promise<Attendee[]> =>
  queryAll<Attendee>(
    `SELECT ${attendeeColumns("inner", ATTENDEE_FIELDS)}
       FROM attendees AS attendee
       JOIN listing_attendees AS listingAttendee ON listingAttendee.attendee_id = attendee.id
      WHERE listingAttendee.listing_id = ?
        AND attendee.kind = ?
      ORDER BY attendee.id`,
    [listingId, SERVICING_KIND],
  );

/** Decrypt the first servicing-kind attendee row booked against `listingId`.
 *  Used to assert on the stored PII shape (name / contact fields) of the
 *  listing's first servicing booking — the shape a servicing event persists.
 *  (Distinct from db-helpers' `decryptFirstAttendee`, which targets normal
 *  attendee-kind rows and asserts exactly one.) */
export const decryptFirstServicingAttendee = async (
  listingId: number,
): Promise<Attendee | null> => {
  const { decryptAttendeeOrNull } = await import("#db/attendees/pii.ts");
  const pk = await getTestPrivateKey();
  const rows = await servicingRowsForListing(listingId);
  return decryptAttendeeOrNull(rows[0]!, pk);
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

/** Assert a POST response is a 302 redirect to a location containing `path`. */
export const assertRedirectTo = (response: Response, path: string): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toContain(path);
};

/** Assert a 302 response's redirect pathname (ignoring flash query params)
 *  equals `expected`. Throws contextually if the Location header is missing. */
export const assertRedirectPathname = (
  response: Response,
  expected: string,
): void => {
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  expect(location).not.toBeNull();
  expect(new URL(location!, "http://x").pathname).toBe(expected);
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

export const listingCostOf = async (listingId: number): Promise<number> => {
  const cost = -(await accountBalance(costAccount(listingId)));
  return Object.is(cost, -0) ? 0 : cost;
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
  await recordServiceCost({
    amount,
    listingId,
    memo: "Boiler part",
    occurredAt: "2026-07-01T00:00:00.000Z",
    servicingId,
  });
  expect(await listingCostOf(listingId)).toBe(expectedTotal);
};

/** Assert a promise rejects, optionally matching a pattern. The §14 validation
 *  and §22 allocation-rule tests both wrap `expect(...).rejects.toThrow()`. */
export const expectRejects = async (
  promise: Promise<unknown>,
  pattern?: RegExp | string,
): Promise<void> => {
  let error: unknown;
  let resolved = true;
  try {
    await promise;
  } catch (err) {
    error = err;
    resolved = false;
  }
  expect(resolved, "expected promise to reject, but it resolved").toBe(false);
  if (pattern !== undefined) {
    // The rejection reason is `unknown`; confirm it's a real Error before
    // reading `.message`, so a non-Error rejection fails here (naming the
    // wrong shape) rather than throwing while evaluating the assertion.
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // A string asserts the exact message; a RegExp matches (for partial/shape).
    if (typeof pattern === "string") {
      expect(message).toBe(pattern);
    } else {
      expect(message).toMatch(pattern);
    }
  }
};

/** The "one daily listing + one dated servicing event" fixture shared by
 *  validation §14 (update-catch) and ledger §22 (occurredAt routing). */
export const createDatedServicingScenario = async (): Promise<{
  id: number;
  listing: Listing;
}> => {
  const { createDailyTestListing } = await import(
    "#test-utils/db-helpers/listings.ts"
  );
  const listing = await createDailyTestListing({ maxAttendees: 5, name: "L" });
  const { id } = await createTestServicingEvent({
    bookings: [{ date: "2026-07-01", listingId: listing.id, quantity: 1 }],
    name: "Dated Service",
  });
  return { id, listing };
};

/** Create two daily listings — the multi-booking fixture shared by §3 (create),
 *  §4 (edit), and §18 (duplicate). */
export const createDailyListingPair = async (
  nameA: string,
  nameB: string,
  maxAttendees = 10,
): Promise<[Listing, Listing]> => {
  const { createDailyTestListing } = await import(
    "#test-utils/db-helpers/listings.ts"
  );
  const a = await createDailyTestListing({ maxAttendees, name: nameA });
  const b = await createDailyTestListing({ maxAttendees, name: nameB });
  return [a, b];
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
  attendee: import("#types").Attendee;
  listing: Listing;
}> => {
  const { createTestAttendeeDirect } = await import(
    "#test-utils/db-helpers/attendees.ts"
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
    `/admin/attendees/${id}/ledger`,
    `/admin/attendees/${id}/merge`,
    `/admin/attendees/${id}/refresh-payment`,
    ...actions.map((a) => `/admin/listing/${listingId}/attendee/${id}/${a}`),
  ];
  for (const path of paths) {
    await assertAdmin404(path, cookie);
  }
};
