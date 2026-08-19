import type { ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { TxScope } from "#db/client.ts";
import { insertRefundConfirmation } from "#db/refund-confirmations.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const transactionReturning = (results: ResultSet[]): TxScope => ({
  batch: () => Promise.resolve(results),
  execute: () => {
    throw new Error("A refund confirmation does not execute single statements");
  },
});

describeWithEnv(
  "db > refund confirmation boundary",
  { encryptionKey: true },
  () => {
    test("refuses an empty provider-reference set before writing", async () => {
      await expect(
        insertRefundConfirmation(transactionReturning([]), {
          attendeeId: 7,
          referenceIndexes: [],
        }),
      ).rejects.toThrow(
        "A refund confirmation needs indexed payment references",
      );
    });

    test("fails when libsql omits the confirmation result", async () => {
      await expect(
        insertRefundConfirmation(transactionReturning([]), {
          attendeeId: 7,
          referenceIndexes: ["reference-index"],
        }),
      ).rejects.toThrow("Refund confirmation write returned no result");
    });
  },
);
