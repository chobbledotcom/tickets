import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { reserveSession } from "#db/processed-payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectLegalJointStates } from "#test-utils/joint-state.ts";

describeWithEnv("joint-state witness", { db: true }, () => {
  test("a bare reservation witnesses as a free row with no charges", async () => {
    await reserveSession("cs_witness_bare");
    // failure_data is empty and the reference joins to no charge — the
    // legal free_reserved × absent combination, asserted without decrypting.
    await expectLegalJointStates("cs_witness_bare", "bare reservation");
  });

  test("refuses to witness a session that stored nothing", async () => {
    await expect(
      expectLegalJointStates("cs_witness_missing", "missing session"),
    ).rejects.toThrow("No payment rows to witness for missing session");
  });
});
