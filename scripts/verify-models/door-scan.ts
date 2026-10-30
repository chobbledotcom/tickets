/** The door scan admission machine: one booking's rows at one door. The
 *  state is the places the door has admitted on the booking's two
 *  representative listings. Every admission fact comes from the production
 *  decision function, so a cap or a gate that slips there makes the checker
 *  reject the derived facts. The model does not prove the database write
 *  or the walk's booking order. */

/* jscpd:ignore-start -- imports */
import { decideScan } from "#routes/admin/scan-decision.ts";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import {
  type ModelDataSource,
  type TlaFact,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";
import { requireValue } from "#shared/required-value.ts";
import type { Attendee, ListingWithCount } from "#types";

/* jscpd:ignore-end */

const admitFields = {
  after: "Int",
  before: "Int",
  idVerified: "Bool",
  listing: "Str",
  nonTransferable: "Bool",
  purchaseOnly: "Bool",
  refunded: "Bool",
} as const;
export type AdmitFact = TlaFact<typeof admitFields>;

/** The booking row fields the door decision reads. The attendee and listing
 *  shapes carry everything else; the decision never touches those fields.
 *  The cast is the one boundary where the generator names the row for the
 *  checker, and the generator test pins the facts it derives. */
type ScanRow = {
  checkedIn: number;
  id: number;
  listingId: number;
  nonTransferable: boolean;
  purchaseOnly: boolean;
  quantity: number;
  refunded: boolean;
};

const rowOf = (row: ScanRow): TokenEntry => ({
  attendee: {
    checked_in: row.checkedIn,
    id: row.id,
    quantity: row.quantity,
    refunded: row.refunded,
  } as Attendee,
  listing: {
    id: row.listingId,
    name: `Listing ${row.listingId}`,
    non_transferable: row.nonTransferable,
    purchase_only: row.purchaseOnly,
  } as ListingWithCount,
  parentListingId: 0,
});

/** The door's own listings: the booking's two representatives, with the
 *  quantity each books. The scan rows, the checker's quantity constants and
 *  the generator test all read this one table, so one change moves all
 *  three together. */
export const representatives = [
  { id: 1, name: "one", quantity: 3 },
  { id: 2, name: "two", quantity: 1 },
] as const;

const [partyListing, guestListing] = representatives;

const DOOR_SCOPE = new Set(
  representatives.map((representative) => representative.id),
);

type Controls = {
  checkEvery?: boolean;
  count?: number;
  force?: boolean;
  idVerified?: boolean;
};

/** The admission facts one scan derives. An admit names the count it really
 *  moved on each covered listing; every other decision admits nothing, so
 *  the rows it names keep their count. */
const factsOf = (
  rows: readonly ScanRow[],
  controls: Controls = {},
): AdmitFact[] => {
  const entries = rows.map(rowOf);
  // The controls default to their off state: unforced, one listing at a
  // time, and no verified ID.
  const forced = Boolean(controls.force);
  const everyListing = Boolean(controls.checkEvery);
  const verified = Boolean(controls.idVerified);
  const decision = decideScan(
    { entries, force: forced, scope: DOOR_SCOPE },
    everyListing,
    verified,
    controls.count,
  );
  const factOf = (
    entry: TokenEntry,
    before: number,
    after: number,
  ): AdmitFact => ({
    after,
    before,
    idVerified: verified,
    listing: requireValue(
      representatives.find(
        (representative) => representative.id === entry.listing.id,
      ),
      `No representative listing ${entry.listing.id}`,
    ).name,
    nonTransferable: entry.listing.non_transferable,
    purchaseOnly: entry.listing.purchase_only,
    refunded: entry.attendee.refunded,
  });
  /** The places this booking already holds on one listing, across all the
   *  rows the scan names on it. */
  const heldBefore = (listingId: number): number => {
    let held = 0;
    for (const entry of entries) {
      if (entry.listing.id === listingId) held += entry.attendee.checked_in;
    }
    return held;
  };
  /** The facts for the rows a non-admit decision names: each keeps its
   *  count. */
  const keptFacts = (named: readonly TokenEntry[]): AdmitFact[] =>
    named.map((entry) =>
      factOf(entry, entry.attendee.checked_in, entry.attendee.checked_in),
    );
  // The switch names every decision kind, so a new kind without a fact rule
  // fails the typecheck instead of deriving wrong facts.
  switch (decision.kind) {
    case "admit":
      // An admit moves the listing's whole count, which spans every row of
      // the booking on that listing, not only the row the unit names first.
      return decision.units.map((unit) => {
        const row = unit.rows[0]!;
        const before = heldBefore(row.listing.id);
        return factOf(row, before, before + unit.tickets);
      });
    case "already_checked_in":
      return keptFacts(decision.live);
    case "select_quantity":
    case "verify_id":
      return keptFacts(decision.rows);
    case "not_found":
    case "refunded":
    case "wrong_listing":
      return keptFacts(entries);
  }
};

/** A three-place party row on the first listing. */
const partyRow = (
  checkedIn: number,
  overrides: Partial<ScanRow> = {},
): ScanRow => ({
  checkedIn,
  id: 7,
  listingId: partyListing.id,
  nonTransferable: false,
  purchaseOnly: false,
  quantity: partyListing.quantity,
  refunded: false,
  ...overrides,
});

/** A single-place row on the second listing. */
const guestRow = (checkedIn: number): ScanRow => ({
  checkedIn,
  id: 8,
  listingId: guestListing.id,
  nonTransferable: false,
  purchaseOnly: false,
  quantity: guestListing.quantity,
  refunded: false,
});

/** The gate rows: a refunded row, an ID-held row and a no-check-in row,
 *  each on the first listing. */
const refundedRow = partyRow(0, { refunded: true });
const heldRow = partyRow(0, { nonTransferable: true });
const noCheckInRow = partyRow(0, { purchaseOnly: true });

/** Every admission the production decision can derive for the two
 *  representative listings. The one-at-a-time walk, the full and capped
 *  picks, and each gate (refunded, no-check-in, ID hold) all land here. */
export const admitFacts = (): AdmitFact[] => [
  // Listing "one": a party of three, admitted place by place.
  ...factsOf([partyRow(0)], { count: 1 }),
  ...factsOf([partyRow(1)], { count: 1 }),
  ...factsOf([partyRow(2)], { count: 1 }),
  // A full pick admits the whole party in one scan.
  ...factsOf([partyRow(0)], { count: 3 }),
  // An over-pick caps at what the listing still owes.
  ...factsOf([partyRow(2)], { count: 5 }),
  // Two rows of one booking on one listing admit against the listing's
  // one count, not one row's count.
  ...factsOf(
    [partyRow(0, { quantity: 2 }), partyRow(0, { id: 9, quantity: 1 })],
    { count: 2 },
  ),
  // A line that owes more than one place and gets no pick asks first, and
  // admits nothing yet.
  ...factsOf([partyRow(0)]),
  // Every place already in: the scan admits nothing.
  ...factsOf([partyRow(3)]),
  // A refunded row never admits.
  ...factsOf([refundedRow]),
  // A non-transferable listing holds the ticket until the ID is verified.
  ...factsOf([heldRow]),
  ...factsOf([heldRow], { count: 1, idVerified: true }),
  // A no-check-in listing admits nothing, even at its own listing.
  ...factsOf([noCheckInRow]),
  // Listing "two": a single ticket.
  ...factsOf([guestRow(0)], { count: 1 }),
  ...factsOf([guestRow(1)]),
  // Without the box, one picked scan admits the first listing that owes
  // only, and never reaches the next one.
  ...factsOf([partyRow(0), guestRow(0)], { count: 1 }),
  // The group's check-every-listing box admits every listing that still
  // owes, and the one-at-a-time walk lands on the next listing when the
  // first is fully in.
  ...factsOf([partyRow(0), guestRow(0)], { checkEvery: true, count: 1 }),
  ...factsOf([partyRow(3), guestRow(0)]),
  // A forced scan of an empty ticket finds no row, so it names no facts.
  ...factsOf([], { force: true }),
];

/** One fact of the clean fact set changed to report the given after count.
 *  The checker must report a counterexample for the corrupted data, or its
 *  clean verdicts prove nothing. Throws when no fact matches, so a changed
 *  fact shape fails here instead of corrupting nothing. */
export const corruptOneFact = (
  match: (fact: AdmitFact) => boolean,
  after: number,
): AdmitFact[] => {
  const facts = admitFacts();
  if (!facts.some(match)) {
    throw new Error("The corrupted control matches no admission fact.");
  }
  return facts.map((fact) => (match(fact) ? { ...fact, after } : fact));
};

/** The walk fact that admits the place after `before` checked-in places. */
const walkFactAt =
  (before: number) =>
  (fact: AdmitFact): boolean =>
    fact.listing === "one" &&
    fact.before === before &&
    fact.after === before + 1;

/** One over-pick fact changed to admit past the listing's quantity. */
export const corruptOneAdmission = (): AdmitFact[] =>
  corruptOneFact(walkFactAt(2), partyListing.quantity + 1);

/** One walk fact changed to take a place back. */
export const corruptOneTakeBack = (): AdmitFact[] =>
  corruptOneFact(walkFactAt(1), 0);

/** The refunded row's fact changed to admit a place. */
export const corruptOneRefundedAdmission = (): AdmitFact[] =>
  corruptOneFact((fact) => fact.refunded, 1);

const moduleFor = (facts: readonly AdmitFact[]): string =>
  tlaModule("DoorScanData", [
    ...representatives.map(
      (representative) =>
        `Quantity${representative.name.charAt(0).toUpperCase()}${representative.name.slice(1)} == ${representative.quantity}`,
    ),
    tlaRecords("AdmitFacts", admitFields, facts),
  ]);

export const doorScanModelData: ModelDataSource = async () =>
  moduleFor(admitFacts());

/** The DoorScan data module with one admission past the listing's quantity,
 *  which the checker must reject. */
export const corruptDoorScanData: ModelDataSource = async () =>
  moduleFor(corruptOneAdmission());

/** The DoorScan data module with one scan taking a place back, which the
 *  checker must reject. */
export const takeBackDoorScanData: ModelDataSource = async () =>
  moduleFor(corruptOneTakeBack());

/** The DoorScan data module with one refunded row admitting a place, which
 *  the checker must reject. */
export const refundedAdmissionDoorScanData: ModelDataSource = async () =>
  moduleFor(corruptOneRefundedAdmission());
