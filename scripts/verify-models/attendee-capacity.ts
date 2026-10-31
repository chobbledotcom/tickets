/** The attendee capacity machine: one atomic attendee edit batch over one
 *  attendee's lines, on two representative slots. Every fact comes from the
 *  production statements run against a seeded in-memory copy of the slots: a
 *  line's fit is its own capacity-checked write landing, and a batch's commit
 *  is the real edit batch surviving its guards. A slip in the statements
 *  shows up as a corrupted fact the checker rejects. The model does not
 *  encode SQL text. */

/* jscpd:ignore-start -- imports */
import type {
  DesiredListingLine,
  ListingAttendeeRow,
} from "#db/attendee-types.ts";
import {
  buildAttendeeEditBatch,
  isUnchangedLine,
  lineKeyFromBooking,
  lineStatementFor,
} from "#db/attendees/atomic-update.ts";
import {
  type BatchFact,
  batchTlaSchema,
  type LineFact,
  lineTlaSchema,
} from "#scripts/verify-models/attendee-capacity-facts.ts";
import {
  ATTENDEE_ID,
  bookingRow,
  existingKeyMap,
  quantityOn,
  type Scenario,
  SLOT_IDS,
  type SlotName,
  seededClient,
  storedAfter,
} from "#scripts/verify-models/attendee-capacity-seed.ts";
import {
  type ModelDataSource,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";

/* jscpd:ignore-end */

/** The two representative slots' fixed caps: the checker constants. */
const QuantityOne = 3;
const QuantityTwo = 2;

/** The scenario slot a listing id books. */
const slotName = (listingId: number): SlotName =>
  listingId === SLOT_IDS.one ? "one" : "two";

/** One desired line on a slot. An existing line carries the key production
 *  derives from the stored row's slot identity; a new line carries the empty
 *  key production uses for a newly-added line. Two lines on one slot book
 *  through two package paths: production reads two same-path lines on a slot
 *  as one duplicate slot and refuses the edit before its batch. */
const line = (
  slot: SlotName,
  quantity: number,
  existing: boolean,
  path: 0 | 1 = 0,
): DesiredListingLine => {
  const draft: DesiredListingLine = {
    date: null,
    durationDays: 1,
    exists: existing,
    key: "",
    listingId: SLOT_IDS[slot],
    quantity,
  };
  // A package path is part of the row's slot identity. A plain line books
  // without one, the way the form sends it, and production resolves the
  // absence to 0. The key names the row through its final slot identity.
  const withPath = path === 0 ? draft : { ...draft, packageGroupId: path };
  return existing
    ? { ...withPath, key: lineKeyFromBooking(bookingRow(withPath)) }
    : withPath;
};

/** The edit kind of one desired line, classified the way production
 *  classifies it: a new line inserts, an unchanged line preserves, a changed
 *  line updates. */
const kindOf = (
  row: DesiredListingLine,
  existingByKey: ReadonlyMap<string, ListingAttendeeRow>,
): LineFact["kind"] => {
  if (!row.exists) return "insert";
  return isUnchangedLine(row, existingByKey) ? "preserve" : "update";
};

/** The production capacity decision for one line: the line's own write, run
 *  against a fresh seeded copy of the slots. A capacity-checked write that
 *  lands fits; a zero-row write is the refusal. A preserve's unconditional
 *  update always lands. A delete is a line's absence, so it never becomes a
 *  fact. */
const fitsFor = async (
  scenario: Scenario,
  row: DesiredListingLine,
): Promise<boolean> => {
  const client = await seededClient(scenario);
  try {
    const { statement } = lineStatementFor(
      row,
      ATTENDEE_ID,
      existingKeyMap(scenario),
    );
    const result = await client.execute(statement);
    return result.rowsAffected === 1;
  } finally {
    client.close();
  }
};

/** The slot's total quantity after the batch commits: the demand that is not
 *  this attendee's own, plus what this attendee then holds. Used for a
 *  refused batch, whose claim the model never stores. */
const totalAfter = (scenario: Scenario, slot: SlotName): number =>
  scenario.booked[slot] -
  quantityOn(scenario.existing, slot) +
  quantityOn(scenario.desired, slot);

/** One scenario's batch fact: the real edit batch, run as one write-mode
 *  transaction, with a committed batch's stored totals and line count read
 *  back from the seeded slots. A guard on a refused write aborts the batch
 *  and rolls everything back, surfacing as a thrown error — that throw is
 *  the observed refusal, not a failure. An empty desired set is production's
 *  `no_lines` rejection, refused before any batch runs. */
const batchFactFor = async (scenario: Scenario): Promise<BatchFact> => {
  const existingByKey = existingKeyMap(scenario);
  const preserveOnly =
    scenario.desired.length > 0 &&
    scenario.desired.every((row) => isUnchangedLine(row, existingByKey));
  const refused = {
    commits: false,
    lineCountAfter: scenario.desired.length,
    slot1AfterTotal: totalAfter(scenario, "one"),
    slot2AfterTotal: totalAfter(scenario, "two"),
  };
  if (scenario.desired.length === 0) {
    return { batch: scenario.tag, preserveOnly, ...refused };
  }
  const client = await seededClient(scenario);
  try {
    await client.batch(
      buildAttendeeEditBatch(
        ATTENDEE_ID,
        scenario.desired,
        existingKeyMap(scenario),
      ),
      "write",
    );
  } catch {
    // A guard on a refused write aborts the batch and rolls everything back,
    // surfacing as a thrown error. That throw is the observed refusal, so the
    // fact records it.
    client.close();
    return { batch: scenario.tag, preserveOnly, ...refused };
  }
  const stored = await storedAfter(client);
  client.close();
  return {
    batch: scenario.tag,
    commits: true,
    lineCountAfter: stored.lineCount,
    preserveOnly,
    slot1AfterTotal: stored.slot1Total,
    slot2AfterTotal: stored.slot2Total,
  };
};

/** One scenario's lines and batch fact. */
const factsFor = async (
  scenario: Scenario,
): Promise<{ batch: BatchFact; lines: LineFact[] }> => {
  const existingByKey = existingKeyMap(scenario);
  const lines: LineFact[] = await Promise.all(
    scenario.desired.map(async (row) => ({
      batch: scenario.tag,
      fits: await fitsFor(scenario, row),
      kind: kindOf(row, existingByKey),
      listing: slotName(row.listingId),
      quantity: row.quantity,
    })),
  );
  return { batch: await batchFactFor(scenario), lines };
};

/** One scenario over the two representative slots. Every scenario edits the
 *  same two listings, so the caps are the fixed checker constants. */
const scenario = (
  tag: string,
  booked: Record<SlotName, number>,
  existing: DesiredListingLine[],
  desired: DesiredListingLine[],
): Scenario => ({
  active: { one: true, two: true },
  booked,
  caps: { one: QuantityOne, two: QuantityTwo },
  desired,
  existing,
  tag,
});

/** One scenario where the attendee already holds the given lines and no
 *  other attendee books the slots, so the booked totals equal the hold. With
 *  `deactivatesListingOne`, listing one is seeded inactive, so the scenario
 *  shows an unchanged preserve surviving a deactivated listing. */
const editingHeld = (
  tag: string,
  existing: DesiredListingLine[],
  desired: DesiredListingLine[],
  deactivatesListingOne = false,
): Scenario => ({
  ...scenario(
    tag,
    {
      one: quantityOn(existing, "one"),
      two: quantityOn(existing, "two"),
    },
    existing,
    desired,
  ),
  active: { one: !deactivatesListingOne, two: true },
});

/** The attendee holds one line on each slot: the start of the two scenarios
 *  that edit both slots. */
const bothSlotsHeld = [line("one", 1, true), line("two", 1, true)];

/** One row per scenario. The generator test pins the fact each row must
 *  produce, and its comments name what each row covers. */
const SCENARIOS: readonly Scenario[] = [
  // A create: the attendee commits one new line on slot one.
  editingHeld("create", [], [line("one", 2, false)]),
  // An unchanged preserve only: no capacity check, so it always commits.
  editingHeld("preserve-only", [line("one", 1, true)], [line("one", 1, true)]),
  // The same preserve on a deactivated listing: the unconditional update
  // must not be stranded, so the batch still commits.
  editingHeld(
    "preserve-inactive",
    [line("one", 1, true)],
    [line("one", 1, true)],
    true,
  ),
  // An update that grows the line but still fits the cap.
  editingHeld("edit-increase", [line("one", 1, true)], [line("one", 2, true)]),
  // An update past the cap: other attendees already hold two places.
  scenario(
    "edit-refused",
    { one: 3, two: 0 },
    [line("one", 1, true)],
    [line("one", 3, true)],
  ),
  // An insert past the cap, beside an unchanged preserve. Nothing of the
  // batch commits.
  editingHeld(
    "insert-refused",
    [line("one", 1, true)],
    [line("one", 1, true), line("one", 3, false, 1)],
  ),
  // An earlier fitting insert on slot two, then a later refused insert on
  // slot one. The refusal must refuse the whole batch, earlier line included.
  scenario(
    "partial-basis",
    { one: 2, two: 0 },
    [],
    [line("two", 1, false), line("one", 2, false)],
  ),
  // A full edit: a preserve, an update, and a new insert all fit. The
  // preserve holds the slot-one row booked through the package, and the new
  // insert joins it on the plain path.
  editingHeld(
    "multi-line-commit",
    [line("one", 1, true, 1), line("two", 1, true)],
    [line("one", 1, true, 1), line("two", 2, true), line("one", 1, false)],
  ),
  // A removal: omitting a line deletes it, and deletes carry no capacity
  // condition.
  editingHeld("delete-line", bothSlotsHeld, [line("one", 1, true)]),
  // A zero-quantity line demands no places, so it lands on a full slot.
  scenario("zero-qty-insert", { one: 3, two: 0 }, [], [line("one", 0, false)]),
  // An empty desired set: production rejects it, so the batch never commits.
  editingHeld("empty-desired", [line("one", 1, true)], []),
];

/** The clean proof facts: every scenario's lines, with each batch's commit
 *  decision observed from the real batch. */
const proofFacts = async (): Promise<{
  batches: BatchFact[];
  lines: LineFact[];
}> => {
  const facts = await Promise.all(SCENARIOS.map(factsFor));
  return {
    batches: facts.map(({ batch }) => batch),
    lines: facts.flatMap(({ lines }) => lines),
  };
};

const moduleFor = (facts: {
  batches: BatchFact[];
  lines: LineFact[];
}): string =>
  tlaModule("AttendeeCapacityData", [
    `QuantityOne == ${QuantityOne}`,
    `QuantityTwo == ${QuantityTwo}`,
    tlaRecords("LineFacts", lineTlaSchema, facts.lines),
    tlaRecords("BatchFacts", batchTlaSchema, facts.batches),
  ]);

/** The clean proof data. The check must pass. */
export const attendeeCapacityModelData: ModelDataSource = async () =>
  moduleFor(await proofFacts());

/** The one batch with a refused insert that would overfill slot one. */
const OVERFILL_TAG = "insert-refused";
/** The one batch with an earlier line and a later refused line. */
const PARTIAL_TAG = "partial-basis";

/** The negative control for an overfill: the capacity condition lets the
 *  refused insert land, so the batch commits past the slot's quantity. The
 *  checker must reject it. */
export const overfillInsertData: ModelDataSource = async () => {
  const facts = await proofFacts();
  const lines = facts.lines.map((fact) =>
    fact.batch === OVERFILL_TAG && fact.kind === "insert"
      ? { ...fact, fits: true }
      : fact,
  );
  const batches = facts.batches.map((batch) =>
    batch.batch === OVERFILL_TAG ? { ...batch, commits: true } : batch,
  );
  return moduleFor({ batches, lines });
};

/** The negative control for a partial commit: the batch claims the commit a
 *  lost guard would leave. The refused insert is the batch's last line, so
 *  only the earlier fitting line lands: the totals and line count shrink to
 *  the survivor, and every slot stays inside its cap. NoPartialCommit alone
 *  must reject it. */
export const partialCommitData: ModelDataSource = async () => {
  const facts = await proofFacts();
  const batches = facts.batches.map((batch) => {
    if (batch.batch !== PARTIAL_TAG) return batch;
    const lines = facts.lines.filter((fact) => fact.batch === batch.batch);
    const refusedOn = (listing: LineFact["listing"]) =>
      lines
        .filter((fact) => !fact.fits && fact.listing === listing)
        .reduce((total, fact) => total + fact.quantity, 0);
    return {
      ...batch,
      commits: true,
      lineCountAfter: lines.filter((fact) => fact.fits).length,
      slot1AfterTotal: batch.slot1AfterTotal - refusedOn("one"),
      slot2AfterTotal: batch.slot2AfterTotal - refusedOn("two"),
    };
  });
  return moduleFor({ batches, lines: facts.lines });
};
