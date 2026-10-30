/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  attendeeCapacityModelData,
  overfillInsertData,
  partialCommitData,
} from "#scripts/verify-models/attendee-capacity.ts";
import { tlaSchemaOf } from "#scripts/verify-models/attendee-capacity-facts.ts";
import { records } from "#test-utils/tla-data.ts";

/* jscpd:ignore-end */

type Fact = Record<string, string | boolean | number>;

/** One line fact, named by field: the batch, its slot, the line's quantity,
 *  its edit kind, and the production capacity decision. */
const line = (
  batch: string,
  fits: boolean,
  kind: string,
  listing: string,
  quantity: number,
): Fact => ({ batch, fits, kind, listing, quantity });

/** One batch fact, named by field: the slot totals and line count after the
 *  batch, whether it commits, and whether it holds only preserves. */
const batch = (
  batch: string,
  commits: boolean,
  lineCountAfter: number,
  preserveOnly: boolean,
  slot1AfterTotal: number,
  slot2AfterTotal: number,
): Fact => ({
  batch,
  commits,
  lineCountAfter,
  preserveOnly,
  slot1AfterTotal,
  slot2AfterTotal,
});

/** The clean proof facts, split into the two checker sets. */
const cleanFacts = async (): Promise<{ batches: Fact[]; lines: Fact[] }> => {
  const data = await attendeeCapacityModelData();
  return {
    batches: records(data, "BatchFacts") as Fact[],
    lines: records(data, "LineFacts") as Fact[],
  };
};

describe("attendee capacity checker data", () => {
  test("carries the production slot quantities as the checker constants", async () => {
    const data = await attendeeCapacityModelData();
    expect(data).toContain("QuantityOne == 3");
    expect(data).toContain("QuantityTwo == 2");
  });

  test("names the data module the runner writes it to", async () => {
    const data = await attendeeCapacityModelData();
    // The runner writes the data to AttendeeCapacityData.tla, and the
    // checker requires the module inside to carry the file's name.
    expect(data).toContain("---- MODULE AttendeeCapacityData ----");
  });

  test("records the production outputs for every line", async () => {
    const { lines } = await cleanFacts();
    // A create: one new line fits an empty slot.
    expect(lines).toContainEqual(line("create", true, "insert", "one", 2));
    // An unchanged preserve: no capacity check, so it always fits.
    expect(lines).toContainEqual(
      line("preserve-only", true, "preserve", "one", 1),
    );
    // An update that grows the line but still fits the cap.
    expect(lines).toContainEqual(
      line("edit-increase", true, "update", "one", 2),
    );
    // An update past the cap, where other attendees already hold two places.
    expect(lines).toContainEqual(
      line("edit-refused", false, "update", "one", 3),
    );
    // A refused insert past the cap, beside its unchanged preserve.
    expect(lines).toContainEqual(
      line("insert-refused", false, "insert", "one", 3),
    );
    // An earlier insert that fits, and a later insert the capacity refuses.
    expect(lines).toContainEqual(
      line("partial-basis", true, "insert", "two", 1),
    );
    expect(lines).toContainEqual(
      line("partial-basis", false, "insert", "one", 2),
    );
    // A full edit: a preserve, an update, and a new insert all fit.
    expect(lines).toContainEqual(
      line("multi-line-commit", true, "preserve", "one", 1),
    );
    expect(lines).toContainEqual(
      line("multi-line-commit", true, "update", "two", 2),
    );
    expect(lines).toContainEqual(
      line("multi-line-commit", true, "insert", "one", 1),
    );
    // A zero-quantity line demands no places, so it fits a full slot.
    expect(lines).toContainEqual(
      line("zero-qty-insert", true, "insert", "one", 0),
    );
  });

  test("records the commit decision for every batch", async () => {
    const { batches } = await cleanFacts();
    // A create commits one line on an empty slot.
    expect(batches).toContainEqual(batch("create", true, 1, false, 2, 0));
    // A preserve-only batch never refuses.
    expect(batches).toContainEqual(batch("preserve-only", true, 1, true, 1, 0));
    // A fitting update commits, and a refused update does not.
    expect(batches).toContainEqual(
      batch("edit-increase", true, 1, false, 2, 0),
    );
    expect(batches).toContainEqual(
      batch("edit-refused", false, 1, false, 5, 0),
    );
    // A refused insert rolls the whole batch back.
    expect(batches).toContainEqual(
      batch("insert-refused", false, 2, false, 4, 0),
    );
    // A later refused line takes an earlier fitting line back with it.
    expect(batches).toContainEqual(
      batch("partial-basis", false, 2, false, 4, 1),
    );
    // A full edit commits all three lines.
    expect(batches).toContainEqual(
      batch("multi-line-commit", true, 3, false, 2, 2),
    );
    // Omitting a line deletes it, and the kept line preserves.
    expect(batches).toContainEqual(batch("delete-line", true, 1, true, 1, 0));
    // A zero-quantity line commits on a full slot without pushing it over.
    expect(batches).toContainEqual(
      batch("zero-qty-insert", true, 1, false, 3, 0),
    );
    // An empty desired set never commits.
    expect(batches).toContainEqual(
      batch("empty-desired", false, 0, false, 0, 0),
    );
  });

  test("the overfill control lets the refused insert land", async () => {
    const data = await overfillInsertData();
    const lines = records(data, "LineFacts") as Fact[];
    const batches = records(data, "BatchFacts") as Fact[];
    // The one refused insert now fits, so the batch commits past the slot's
    // quantity: slot one after holds four against a cap of three.
    expect(lines).toContainEqual(
      line("insert-refused", true, "insert", "one", 3),
    );
    expect(batches).toContainEqual(
      batch("insert-refused", true, 2, false, 4, 0),
    );
    // Every other line and batch keeps its honest verdict.
    expect(lines).toContainEqual(
      line("edit-refused", false, "update", "one", 3),
    );
    expect(batches).toContainEqual(
      batch("partial-basis", false, 2, false, 4, 1),
    );
  });

  test("the partial control commits a batch with a later refused line", async () => {
    const data = await partialCommitData();
    const lines = records(data, "LineFacts") as Fact[];
    const batches = records(data, "BatchFacts") as Fact[];
    // The later slot-one insert stays refused, but the batch claims to
    // commit anyway, so the earlier slot-two line survives alone: the
    // refused line's places never land, and both slots stay inside their
    // caps, so NoPartialCommit alone can reject the control.
    expect(lines).toContainEqual(
      line("partial-basis", false, "insert", "one", 2),
    );
    expect(batches).toContainEqual(
      batch("partial-basis", true, 1, false, 2, 1),
    );
    // The overfill batch stays refused, so only the intended control breaks.
    expect(batches).toContainEqual(
      batch("insert-refused", false, 2, false, 4, 0),
    );
  });
});

describe("the checker type note derivation", () => {
  test("stops on a field type with no checker note", () => {
    // A field type outside the table has no checker note. The derivation
    // stops instead of writing a wrong note the checker set would trust.
    expect(() => tlaSchemaOf(v.object({ tags: v.array(v.string()) }))).toThrow(
      "No checker type note for field type array.",
    );
  });
});
