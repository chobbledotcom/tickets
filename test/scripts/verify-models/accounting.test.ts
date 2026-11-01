import { expect } from "@std/expect";
import { corruptSplitData } from "#scripts/verify-models/largest-remainder-split.ts";
import { records } from "#test-utils/tla-data.ts";
import { registeredModel } from "./registered-model.ts";

Deno.test("the accounting control retains negative outstanding money in the initial facts", async () => {
  const data = await registeredModel(
    "LargestRemainderSplit",
  ).controls[2]!.data();
  expect(
    records(data, "SplitCases").filter(
      (fact) => fact.caseTag === "zero amount",
    ),
  ).toEqual([{ capped: false, caseTag: "zero amount", leftover: -1 }]);
});

Deno.test("the accounting control rejects a missing victim instead of changing no fact", async () => {
  await expect(
    corruptSplitData("negative accounting", { caseFacts: [], partFacts: [] }),
  ).rejects.toThrow(/zero-amount split/);
});
