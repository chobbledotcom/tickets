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
  nonTransferable?: boolean;
  purchaseOnly?: boolean;
  quantity: number;
  refunded?: boolean;
};

const rowOf = (row: ScanRow): TokenEntry => ({
  attendee: {
    checked_in: row.checkedIn,
    id: row.id,
    quantity: row.quantity,
    refunded: row.refunded ?? false,
  } as Attendee,
  listing: {
    id: row.listingId,
    name: `Listing ${row.listingId}`,
    non_transferable: row.nonTransferable ?? false,
    purchase_only: row.purchaseOnly ?? false,
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
  const decision = decideScan(
    { entries, force: false, scope: DOOR_SCOPE },
    controls.checkEvery ?? false,
    controls.idVerified ?? false,
    controls.count,
  );
  const factOf = (entry: TokenEntry, after: number): AdmitFact => ({
    after,
    before: entry.attendee.checked_in,
    idVerified: controls.idVerified ?? false,
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
  /** The facts for the rows a non-admit decision names: each keeps its
   *  count. */
  const keptFacts = (named: readonly TokenEntry[]): AdmitFact[] =>
    named.map((entry) => factOf(entry, entry.attendee.checked_in));
  // The switch names every decision kind, so a new kind without a fact rule
  // fails the typecheck instead of deriving wrong facts.
  switch (decision.kind) {
    case "admit":
      return decision.units.map((unit) => {
        const row = unit.rows[0]!;
        return factOf(row, row.attendee.checked_in + unit.tickets);
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
  quantity: partyListing.quantity,
  ...overrides,
});

/** A single-place row on the second listing. */
const guestRow = (checkedIn: number): ScanRow => ({
  checkedIn,
  id: 8,
  listingId: guestListing.id,
  quantity: guestListing.quantity,
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
  // The group's check-every-listing box admits every listing that still
  // owes, and the one-at-a-time walk lands on the next listing when the
  // first is fully in.
  ...factsOf([partyRow(0), guestRow(0)], { checkEvery: true, count: 1 }),
  ...factsOf([partyRow(3), guestRow(0)]),
];

/** One over-pick fact changed to admit past the listing's quantity. The
 *  checker must report a counterexample for this data, or its clean
 *  verdicts prove nothing. */
export const corruptOneAdmission = (): AdmitFact[] =>
  admitFacts().map((fact) =>
    fact.listing === "one" && fact.before === 2 && fact.after === 3
      ? { ...fact, after: partyListing.quantity + 1 }
      : fact,
  );

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
