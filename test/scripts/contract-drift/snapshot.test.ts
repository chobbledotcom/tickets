import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { currentContracts } from "#scripts/contract-drift/dump.ts";

test("the committed contract snapshot matches the declared machines", async () => {
  // verification/JointState.tla cuts its move tables from this snapshot. A
  // machine edit lands here first; re-cut the spec's tables and run
  // 'deno task verify:models' before you merge.
  const snapshot = JSON.parse(
    await Deno.readTextFile("verification/contract-snapshot.json"),
  );
  expect(await currentContracts()).toEqual(snapshot);
});
