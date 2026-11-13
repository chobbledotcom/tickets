import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { TransactionValidationError } from "#db/transaction.ts";
import {
  transactionValidationMessageOrRethrow,
  writeEntityOrValidationResponse,
} from "#shared/rest/write-error.ts";

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

test("answers a written row", async () => {
  const row = { id: 4 };
  expect(
    await writeEntityOrValidationResponse(() => Promise.resolve(row)),
  ).toEqual({ row });
});

test("answers a validation conflict as JSON", async () => {
  const result = await writeEntityOrValidationResponse(() =>
    Promise.reject(new TransactionValidationError("Taken")),
  );
  expect("response" in result).toBe(true);
  if (!("response" in result)) throw new Error("expected a response");
  expect(result.response.status).toBe(400);
  expect(await result.response.json()).toEqual({ error: "Taken" });
});

test("rethrows another failure", async () => {
  await expect(
    writeEntityOrValidationResponse(() => Promise.reject(new Error("Broken"))),
  ).rejects.toThrow("Broken");
});
