/** The payment row atlas: identity, layout, the edges the spec's real
 * transitions discover, and the lifecycle facts each node shows. The cell
 * table itself is proven in test/shared/payment/row-machine-spec.test.ts;
 * this file pins what the /admin/schema page draws. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PAYMENT_ROW_LIFECYCLE } from "#shared/payment/admit-move.ts";
import { rowLifecycleAtlas } from "#shared/schema-atlas/row-lifecycle.ts";
import { indexMachine } from "#test/shared/schema-atlas/helpers.ts";

const { byId, edgeIds, machine } = indexMachine(rowLifecycleAtlas());

describe("the payment row atlas", () => {
  test("declares its identity, keys, and every node's place on the map", () => {
    expect(machine.id).toBe("row");
    expect(machine.titleKey).toBe("schema.row.title");
    expect(machine.introKey).toBe("schema.row.intro");
    // A row starts free, and nowhere else.
    expect(
      machine.states.filter(({ start }) => start === true).map(({ id }) => id),
    ).toEqual(["free"]);
    expect(
      machine.states.map(({ id, labelKey, layout }) => ({
        id,
        labelKey,
        layout,
      })),
    ).toEqual([
      {
        id: "free",
        labelKey: "schema.row.state.free",
        layout: { x: 110, y: 250 },
      },
      {
        id: "claim",
        labelKey: "schema.row.state.claim",
        layout: { x: 370, y: 110 },
      },
      {
        id: "review",
        labelKey: "schema.row.state.review",
        layout: { x: 640, y: 250 },
      },
      {
        id: "unrecorded",
        labelKey: "schema.row.state.unrecorded",
        layout: { x: 640, y: 400 },
      },
      {
        id: "claim_review",
        labelKey: "schema.row.state.claim_review",
        layout: { x: 640, y: 110 },
      },
      {
        id: "claim_unrecorded",
        labelKey: "schema.row.state.claim_unrecorded",
        layout: { x: 370, y: 400 },
      },
      {
        id: "review_unrecorded",
        labelKey: "schema.row.state.review_unrecorded",
        layout: { x: 900, y: 250 },
      },
      {
        id: "claim_review_unrecorded",
        labelKey: "schema.row.state.claim_review_unrecorded",
        layout: { x: 900, y: 110 },
      },
      {
        id: "settled",
        labelKey: "schema.row.state.settled",
        layout: { x: 110, y: 540 },
      },
    ]);
  });

  test("a free row can be held or ended, and an ended row only re-ends", () => {
    expect(edgeIds("free")).toEqual([
      "claim_granted=>claim",
      "write_outcome=>settled",
    ]);
    expect(edgeIds("settled")).toEqual(["write_outcome=>settled"]);
  });

  test("a held row settles somewhere for every kind of work", () => {
    expect(edgeIds("claim")).toEqual([
      "settle_release=>free",
      "settle_recorded=>free",
      "settle_found_unrecorded=>unrecorded",
      "settle_open_partially_returned_obligation=>review",
      "settle_open_shared_reference=>review",
      "settle_retire_partially_returned_obligation=>free",
      "settle_retire_shared_reference=>free",
    ]);
  });

  test("ownerless work only moves by being held first", () => {
    expect(edgeIds("review")).toEqual(["claim_granted=>claim_review"]);
    expect(edgeIds("unrecorded")).toEqual(["claim_granted=>claim_unrecorded"]);
    expect(edgeIds("review_unrecorded")).toEqual([
      "claim_granted=>claim_review_unrecorded",
    ]);
  });

  test("each node shows the lifecycle facts of its worst work", () => {
    expect(byId.get("claim")!.facts).toEqual([
      { labelKey: "schema.fact.cleared_by", value: "settleAttendeeRows" },
      {
        labelKey: "schema.fact.route",
        value: PAYMENT_ROW_LIFECYCLE.claim.operatorRoute,
      },
      { labelKey: "schema.fact.status", value: "moving" },
    ]);
    expect(byId.get("review")!.facts).toEqual([
      { labelKey: "schema.fact.cleared_by", value: "settleAttendeeRows" },
      {
        labelKey: "schema.fact.route",
        value: PAYMENT_ROW_LIFECYCLE.review.operatorRoute,
      },
      { labelKey: "schema.fact.status", value: "needs_review" },
    ]);
    expect(byId.get("review_unrecorded")!.facts[2]).toEqual({
      labelKey: "schema.fact.status",
      value: "needs_review",
    });
    expect(byId.get("free")!.facts).toEqual([]);
    expect(byId.get("settled")!.facts).toEqual([]);
  });
});
