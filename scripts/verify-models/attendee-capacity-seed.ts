/** The seeded in-memory copy of one scenario's slots: the production schema
 *  and triggers, the scenario's listings, and the attendee's existing rows.
 *  Every production statement the fact generator runs lands on this copy, so
 *  a fact is the real write's outcome and never a stored copy of a verdict. */

/* jscpd:ignore-start -- imports */
import { type Client, createClient } from "@libsql/client";
import type {
  DesiredListingLine,
  ListingAttendeeRow,
} from "#db/attendee-types.ts";
import { lineKeyFromBooking } from "#db/attendees/atomic-update.ts";
import { TRIGGERS } from "#db/migrations/schema/triggers.ts";
import { fullSchemaCreateStatements } from "#db/migrations/schema-sync.ts";
/* jscpd:ignore-end */

/** The two representative slots and their fixed listing ids. */
export const SLOT_IDS = { one: 1, two: 2 } as const;
export type SlotName = keyof typeof SLOT_IDS;

/** The attendee every scenario edits. */
export const ATTENDEE_ID = 7;

/** One scenario: the slots' caps, active flags, and current demand; the
 *  attendee's existing lines; and the desired final line set. */
export type Scenario = {
  active: Record<SlotName, boolean>;
  booked: Record<SlotName, number>;
  caps: Record<SlotName, number>;
  desired: DesiredListingLine[];
  existing: DesiredListingLine[];
  tag: string;
};

/** The summed quantity of the lines on one slot. */
export const quantityOn = (
  lines: readonly DesiredListingLine[],
  slot: SlotName,
): number =>
  lines
    .filter((row) => row.listingId === SLOT_IDS[slot])
    .reduce((total, row) => total + row.quantity, 0);

/** The stored row one existing line names: the line's slot identity and
 *  quantity, with the row's other columns at their stored defaults. The
 *  scenarios are dateless, so the row's stored range is null. */
export const bookingRow = (line: DesiredListingLine): ListingAttendeeRow => ({
  attachment_downloads: 0,
  checked_in: 0,
  end_at: null,
  ledger_event_group: "",
  listing_id: line.listingId,
  order_token: "",
  package_group_id: line.packageGroupId ?? 0,
  parent_listing_id: line.parentListingId ?? 0,
  price_paid: 0,
  quantity: line.quantity,
  refunded: 0,
  start_at: null,
});

/** The existing rows keyed the way production keys them. */
export const existingKeyMap = (
  scenario: Scenario,
): ReadonlyMap<string, ListingAttendeeRow> =>
  new Map(
    scenario.existing.map((row) => {
      const booking = bookingRow(row);
      return [lineKeyFromBooking(booking), booking] as const;
    }),
  );

/** One seeded in-memory copy of a scenario's slots. The group tables stay
 *  empty, so the group clause never refuses. The listings' booked total is
 *  seeded without the attendee's own hold, and the aggregates trigger raises
 *  it as the existing rows land. */
export const seededClient = async (scenario: Scenario): Promise<Client> => {
  const client = createClient({ url: ":memory:" });
  for (const sql of fullSchemaCreateStatements()) await client.execute(sql);
  for (const trigger of TRIGGERS) await client.execute(trigger.sql);
  for (const slot of ["one", "two"] as const) {
    await client.execute({
      args: [
        SLOT_IDS[slot],
        scenario.caps[slot],
        scenario.booked[slot] - quantityOn(scenario.existing, slot),
        scenario.active[slot] ? 1 : 0,
      ],
      sql: `INSERT INTO listings (id, max_attendees, booked_quantity, active, created)
            VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    });
    for (const row of scenario.existing) {
      if (row.listingId !== SLOT_IDS[slot]) continue;
      await client.execute({
        args: [
          SLOT_IDS[slot],
          ATTENDEE_ID,
          row.quantity,
          row.packageGroupId ?? 0,
        ],
        sql: `INSERT INTO listing_attendees
              (listing_id, attendee_id, quantity, package_group_id)
              VALUES (?, ?, ?, ?)`,
      });
    }
  }
  return client;
};

/** The stored state after a committed batch: the trigger-maintained demand on
 *  each slot, and the attendee's stored line count. The plain SELECT over no
 *  FROM returns exactly one row. */
export const storedAfter = async (
  client: Client,
): Promise<{ lineCount: number; slot1Total: number; slot2Total: number }> => {
  const { rows } = await client.execute({
    args: [ATTENDEE_ID, SLOT_IDS.one, SLOT_IDS.two],
    sql: `SELECT (SELECT COUNT(*) FROM listing_attendees
                  WHERE attendee_id = ?) AS lineCount,
                 (SELECT booked_quantity FROM listings WHERE id = ?) AS slot1Total,
                 (SELECT booked_quantity FROM listings WHERE id = ?) AS slot2Total`,
  });
  const row = rows[0]!;
  return {
    lineCount: Number(row.lineCount),
    slot1Total: Number(row.slot1Total),
    slot2Total: Number(row.slot2Total),
  };
};
