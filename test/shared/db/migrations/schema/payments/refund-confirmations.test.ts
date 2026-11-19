import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  refundConfirmationReferenceTable,
  refundConfirmationTable,
} from "#db/migrations/schema/payments/refund-confirmations.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete refund confirmation declaration exact", async () => {
  expect(await jsonHash(sqlText(refundConfirmationTable))).toBe(
    "cab6f146d29fa7215d81168de33198dcd7179fcdf57a0313a4ef40377b2ec35d",
  );
  expect(await jsonHash(sqlText(refundConfirmationReferenceTable))).toBe(
    "15c93457665452a7868b253f993543eaf9878915a19c9eaed7ef1be65586f698",
  );
});

test("names each returned payment reference once per confirmation", () => {
  const references = refundConfirmationReferenceTable[1];

  expect(sqlText(references.indexes)).toContainEqual({
    columns: ["confirmation_identity", "reference_index"],
    name: "idx_refund_confirmation_references_unique",
    unique: true,
  });
});
