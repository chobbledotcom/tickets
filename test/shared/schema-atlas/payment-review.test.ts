import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PAYMENT_REVIEW_RETIREMENT } from "#payment/review.ts";
import { paymentReviewAtlas } from "#shared/schema-atlas/payment-review.ts";
import { indexMachine } from "#test/shared/schema-atlas/helpers.ts";

const { byId, edgeIds, machine } = indexMachine(paymentReviewAtlas());

describe("the payment review atlas", () => {
  test("declares its identity, keys, and every node's place on the map", () => {
    expect(machine.id).toBe("review");
    expect(machine.titleKey).toBe("schema.review.title");
    expect(machine.introKey).toBe("schema.review.intro");
    // The empty slot is where a fresh row starts, and nowhere else is.
    expect(
      machine.states.filter(({ start }) => start === true).map(({ id }) => id),
    ).toEqual(["none"]);
    expect(
      machine.states.map(({ id, labelKey, detailKey, layout }) => ({
        detailKey,
        id,
        labelKey,
        layout,
      })),
    ).toEqual([
      {
        detailKey: "schema.review.state.none.detail",
        id: "none",
        labelKey: "schema.review.state.none",
        layout: { x: 140, y: 160 },
      },
      {
        detailKey: "schema.review.state.open.detail",
        id: "open",
        labelKey: "schema.review.state.open",
        layout: { x: 480, y: 160 },
      },
      {
        detailKey: "schema.review.state.seen.detail",
        id: "seen",
        labelKey: "schema.review.state.seen",
        layout: { x: 820, y: 160 },
      },
    ]);
  });

  test("derives its opening reasons from the declared retirement table", () => {
    const openReasons = byId
      .get("none")!
      .edges.map((edge) => edge.labelKey)
      .sort();
    expect(openReasons).toEqual(
      Object.keys(PAYMENT_REVIEW_RETIREMENT)
        .map((kind) => `schema.review.reason.${kind}`)
        .sort(),
    );
  });

  test("a case opens, can be seen, and retires only on its declared evidence", () => {
    expect(edgeIds("none")).toEqual([
      "partially_returned_obligation=>open",
      "shared_reference=>open",
    ]);
    expect(edgeIds("open")).toEqual([
      "acknowledge=>seen",
      "all_returned_and_recorded=>none",
      "unique_reference=>none",
    ]);
    expect(edgeIds("seen")).toEqual([
      "all_returned_and_recorded=>none",
      "unique_reference=>none",
    ]);
  });

  test("acknowledging is the only owner move, and it is not an exit", () => {
    const ownerEdges = machine.states.flatMap((state) =>
      state.edges.filter((edge) => edge.actor === "owner"),
    );
    expect(ownerEdges.map((edge) => edge.labelKey)).toEqual([
      "schema.review.edge.acknowledge",
    ]);
    expect(ownerEdges[0]!.to).toBe("seen");
  });

  test("every declared retirement evidence appears from both open and seen", () => {
    for (const evidence of Object.values(PAYMENT_REVIEW_RETIREMENT)) {
      expect(edgeIds("open")).toContain(`${evidence}=>none`);
      expect(edgeIds("seen")).toContain(`${evidence}=>none`);
    }
  });
});
