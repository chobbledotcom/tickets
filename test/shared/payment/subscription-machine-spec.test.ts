import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LIVE_STATUSES,
  observedStatusNode,
  SUBSCRIPTION_EVENTS,
  SUBSCRIPTION_MOVES,
  SUBSCRIPTION_NODES,
} from "#payment/subscription-machine-spec.ts";
import { movesIn } from "#shared/schema-atlas/machine-spec.ts";
import { machineGraph } from "#test-utils/machine-graph.ts";

const graph = machineGraph({
  events: SUBSCRIPTION_EVENTS,
  label: "subscription",
  nodes: SUBSCRIPTION_NODES,
  targets: movesIn(SUBSCRIPTION_MOVES).targets,
});

describe("subscription machine", () => {
  test("puts every Stripe status on the live or the ended node", () => {
    expect(
      SUBSCRIPTION_NODES.map((node) => [
        node.id,
        node.reps.map((rep) => rep.tag),
      ]),
    ).toEqual([
      ["none", ["no_subscription"]],
      [
        "live",
        ["active", "incomplete", "past_due", "paused", "trialing", "unpaid"],
      ],
      ["ended", ["canceled", "incomplete_expired"]],
    ]);
  });

  test("reaches an ended subscription from a booking with none", () => {
    expect(graph.reachableFrom("none")).toEqual(
      new Set(["ended", "live", "none"]),
    );
    expect(graph.successors("ended")).toEqual([]);
  });

  test("asks Stripe about live subscriptions only", () => {
    expect(LIVE_STATUSES).toEqual([
      "active",
      "incomplete",
      "past_due",
      "paused",
      "trialing",
      "unpaid",
    ]);
  });

  test("moves a live row by the status Stripe reports, and refuses an ended row", () => {
    expect(observedStatusNode("trialing", "active")).toBe("live");
    expect(observedStatusNode("past_due", "canceled")).toBe("ended");
    expect(() => observedStatusNode("canceled", "active")).toThrow(
      "A canceled subscription refuses what Stripe reports",
    );
  });
});
