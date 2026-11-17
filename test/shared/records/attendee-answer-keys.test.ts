import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ATTENDEE_FEATURE_KEYS } from "#shared/records/attendee-answer-keys.ts";

test("the split-agents key of an attendee answer needs logistics", () => {
  expect(ATTENDEE_FEATURE_KEYS).toEqual([
    { feature: "logistics", key: "splitLogisticsAgents" },
  ]);
});
