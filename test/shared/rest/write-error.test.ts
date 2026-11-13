import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { TransactionValidationError } from "#db/transaction.ts";
import { transactionValidationMessageOrRethrow } from "#shared/rest/write-error.ts";

test("returns the message for transaction validation errors", () => {
  expect(
    transactionValidationMessageOrRethrow(
      new TransactionValidationError("Blocked"),
    ),
  ).toBe("Blocked");
});

test("rethrows ordinary errors", () => {
  expect(() =>
    transactionValidationMessageOrRethrow(new Error("Broken")),
  ).toThrow("Broken");
});
