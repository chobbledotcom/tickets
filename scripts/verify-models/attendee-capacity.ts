/** The attendee capacity machine: one atomic attendee edit batch over one
 *  attendee's lines, on two representative slots. Every capacity decision
 *  comes from the production capacity condition run against a seeded
 *  in-memory copy of the slots, so a slip in the condition shows up as a
 *  corrupted fact the checker rejects. The model does not encode SQL text. */

/* jscpd:ignore-start -- imports */
import { type Client, createClient } from "@libsql/client";
import type { ListingAttendeeRow } from "#db/attendee-types.ts";
import { lineKeyFromBooking } from "#db/attendees/atomic-update.ts";
import { capacityConditionFor } from "#db/capacity.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import {
  type BatchFact,
  batchTlaSchema,
  type LineFact,
  lineTlaSchema,
} from "#scripts/verify-models/attendee-capacity-facts.ts";
import {
  type ModelDataSource,
  tlaModule,
  tlaRecords,
} from "#scripts/verify-models/data.ts";

/* jscpd:ignore-end */

/** The two representative slots and their fixed listing ids and caps. */
const SLOT_IDS = { one: 1, two: 2 } as const;
const QuantityOne = 3;
const QuantityTwo = 2;
type SlotName = keyof typeof SLOT_IDS;

/** The attendee every scenario edits. */
const ATTENDEE_ID = 7;

/** One line of an attendee's edit: which slot it books, its quantity, and
 *  whether it names an existing row (false for a new line). */
type Line = { quantity: number; slot: SlotName; existing: boolean };

/** One scenario: the slots' caps and current demand, the attendee's existing
 *  lines, and the desired final line set. */
type Scenario = {
  booked: Record<SlotName, number>;
  caps: Record<SlotName, number>;
  desired: Line[];
  existing: Line[];
  tag: string;
};

/** The canonical row key, read from the production key function. Every
 *  existing scenario row uses the same parent and package identity, so the
 *  key reduces to the slot. A new line carries the empty key production uses
 *  for a newly-added line, so it never collides with an existing row. */
const rowKey = (row: Line): string =>
  row.existing
    ? lineKeyFromBooking({
        listing_id: SLOT_IDS[row.slot],
        package_group_id: 0,
        parent_listing_id: 0,
        start_at: null,
      } as ListingAttendeeRow)
    : "";

/** The edit kind of one desired line: a new key inserts, a kept key with the
 *  same quantity preserves, a kept key with a new quantity updates. */
const kindOf = (
  row: Line,
  existingQuantityByKey: ReadonlyMap<string, number>,
): LineFact["kind"] => {
  const existingQuantity = existingQuantityByKey.get(rowKey(row));
  if (existingQuantity === undefined) return "insert";
  return existingQuantity === row.quantity ? "preserve" : "update";
};

const CREATE_LISTINGS =
  "CREATE TABLE listings (id INTEGER PRIMARY KEY, max_attendees INTEGER, " +
  "booked_quantity INTEGER, active INTEGER, listing_type TEXT)";
const CREATE_ATTENDEES =
  "CREATE TABLE listing_attendees (id INTEGER PRIMARY KEY, listing_id INTEGER, " +
  "attendee_id INTEGER, quantity INTEGER, start_at TEXT, end_at TEXT, " +
  "parent_listing_id INTEGER, package_group_id INTEGER)";
const CREATE_GROUPS =
  "CREATE TABLE groups (id INTEGER PRIMARY KEY, max_attendees INTEGER)";
const CREATE_GROUP_MEMBERS =
  "CREATE TABLE group_listings (group_id INTEGER, listing_id INTEGER)";

/** One seeded in-memory copy of a scenario's slots. The group tables stay
 *  empty, so the group clause never refuses. */
const seededClient = async (scenario: Scenario): Promise<Client> => {
  const client = createClient({ url: ":memory:" });
  await client.execute(CREATE_LISTINGS);
  await client.execute(CREATE_ATTENDEES);
  await client.execute(CREATE_GROUPS);
  await client.execute(CREATE_GROUP_MEMBERS);
  for (const slot of ["one", "two"] as const) {
    await client.execute({
      args: [
        SLOT_IDS[slot],
        scenario.caps[slot],
        scenario.booked[slot],
        1,
        "standard",
      ],
      sql: `INSERT INTO listings
            (id, max_attendees, booked_quantity, active, listing_type)
            VALUES (?, ?, ?, ?, ?)`,
    });
    for (const row of scenario.existing) {
      if (row.slot !== slot) continue;
      await client.execute({
        args: [SLOT_IDS[slot], ATTENDEE_ID, row.quantity],
        sql: `INSERT INTO listing_attendees
              (listing_id, attendee_id, quantity)
              VALUES (?, ?, ?)`,
      });
    }
  }
  return client;
};

/** The production capacity decision for one line, run against the seeded
 *  slots. An update excludes the attendee's own rows; an insert counts them.
 *  A preserve or delete carries no capacity condition, so it always fits. */
const fitsFor = async (
  client: Client,
  row: Line,
  kind: LineFact["kind"],
): Promise<boolean> => {
  if (kind === "preserve" || kind === "delete") return true;
  const statement = numberedStatement(
    capacityConditionFor(
      {
        date: null,
        durationDays: 1,
        listingId: SLOT_IDS[row.slot],
        quantity: row.quantity,
      },
      kind === "update" ? ATTENDEE_ID : undefined,
    ),
  );
  const result = await client.execute({
    args: statement.args,
    sql: `SELECT 1 WHERE (${statement.sql})`,
  });
  return result.rows.length === 1;
};

/** The summed quantity of the lines on one slot. */
const quantityOn = (lines: readonly Line[], slot: SlotName): number =>
  lines
    .filter((row) => row.slot === slot)
    .reduce((total, row) => total + row.quantity, 0);

/** The slot's total quantity after the batch commits: the demand that is not
 *  this attendee's own, plus what this attendee then holds. */
const totalAfter = (scenario: Scenario, slot: SlotName): number =>
  scenario.booked[slot] -
  quantityOn(scenario.existing, slot) +
  quantityOn(scenario.desired, slot);

/** One scenario's lines and batch fact. */
const factsFor = async (
  scenario: Scenario,
): Promise<{ batch: BatchFact; lines: LineFact[] }> => {
  const client = await seededClient(scenario);
  try {
    const existingQuantityByKey = new Map(
      scenario.existing.map((row) => [rowKey(row), row.quantity]),
    );
    const lines: LineFact[] = [];
    for (const row of scenario.desired) {
      const kind = kindOf(row, existingQuantityByKey);
      lines.push({
        batch: scenario.tag,
        fits: await fitsFor(client, row, kind),
        kind,
        listing: row.slot,
        quantity: row.quantity,
      });
    }
    const everyDesiredPreserves =
      scenario.desired.length > 0 &&
      scenario.desired.every(
        (row) => kindOf(row, existingQuantityByKey) === "preserve",
      );
    return {
      batch: {
        batch: scenario.tag,
        commits: false,
        lineCountAfter: scenario.desired.length,
        preserveOnly: everyDesiredPreserves,
        slot1AfterTotal: totalAfter(scenario, "one"),
        slot2AfterTotal: totalAfter(scenario, "two"),
      },
      lines,
    };
  } finally {
    client.close();
  }
};

/** One scenario row on a slot. */
const line = (slot: SlotName, quantity: number, existing: boolean): Line => ({
  existing,
  quantity,
  slot,
});

/** One scenario over the two representative slots. Every scenario edits the
 *  same two listings, so the caps are the fixed checker constants. */
const scenario = (
  tag: string,
  booked: Record<SlotName, number>,
  existing: Line[],
  desired: Line[],
): Scenario => ({
  booked,
  caps: { one: QuantityOne, two: QuantityTwo },
  desired,
  existing,
  tag,
});

/** One scenario where the attendee already holds the given lines and no
 *  other attendee books the slots, so the booked totals equal the hold. */
const editingHeld = (
  tag: string,
  existing: Line[],
  desired: Line[],
): Scenario =>
  scenario(
    tag,
    { one: quantityOn(existing, "one"), two: quantityOn(existing, "two") },
    existing,
    desired,
  );

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
  // An update that grows the line but still fits the cap.
  editingHeld("edit-increase", [line("one", 1, true)], [line("one", 2, true)]),
  // An update past the cap: other attendees already hold two places.
  scenario(
    "edit-refused",
    { one: 3, two: 0 },
    [line("one", 1, true)],
    [line("one", 3, true)],
  ),
  // An insert past the cap, beside an unchanged preserve. The refused insert
  // rolls the whole batch back.
  editingHeld(
    "insert-refused",
    [line("one", 1, true)],
    [line("one", 1, true), line("one", 3, false)],
  ),
  // An earlier fitting insert on slot two, then a later refused insert on
  // slot one. The refusal must take the earlier line back with it.
  scenario(
    "partial-basis",
    { one: 2, two: 0 },
    [],
    [line("two", 1, false), line("one", 2, false)],
  ),
  // A full edit: a preserve, an update, and a new insert all fit.
  editingHeld("multi-line-commit", bothSlotsHeld, [
    line("one", 1, true),
    line("two", 2, true),
    line("one", 1, false),
  ]),
  // A removal: omitting a line deletes it, and deletes carry no capacity
  // condition.
  editingHeld("delete-line", bothSlotsHeld, [line("one", 1, true)]),
  // A zero-quantity line demands no places, so it lands on a full slot.
  scenario("zero-qty-insert", { one: 3, two: 0 }, [], [line("one", 0, false)]),
  // An empty desired set: production rejects it, so the batch never commits.
  editingHeld("empty-desired", [line("one", 1, true)], []),
];

/** The committed fact for a scenario's lines: the batch commits exactly when
 *  every capacity-checked line fits and at least one line remains. */
const committedBatch = (
  batch: BatchFact,
  lines: readonly LineFact[],
): BatchFact => {
  const allFit = lines.every((fact) => fact.fits);
  return { ...batch, commits: allFit && batch.lineCountAfter >= 1 };
};

/** The clean proof facts: every scenario's lines, with each batch's commit
 *  decision derived from them. */
const proofFacts = async (): Promise<{
  batches: BatchFact[];
  lines: LineFact[];
}> => {
  const facts = await Promise.all(SCENARIOS.map(factsFor));
  return {
    batches: facts.map(({ batch, lines }) => committedBatch(batch, lines)),
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
    batch.batch === OVERFILL_TAG
      ? committedBatch(
          batch,
          lines.filter((fact) => fact.batch === batch.batch),
        )
      : batch,
  );
  return moduleFor({ batches, lines });
};

/** The negative control for a partial commit: the batch commits with a later
 *  refused line, so an earlier line survives. The checker must reject it. */
export const partialCommitData: ModelDataSource = async () => {
  const facts = await proofFacts();
  const batches = facts.batches.map((batch) =>
    batch.batch === PARTIAL_TAG ? { ...batch, commits: true } : batch,
  );
  return moduleFor({ batches, lines: facts.lines });
};
