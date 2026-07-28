import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  PaymentUserError,
  withCheckoutError,
} from "#shared/payment-helpers.ts";

const failingCheckout = (error: Error) =>
  withCheckoutError(() => Promise.reject(error));

test("passes a working checkout straight back", async () => {
  expect(await withCheckoutError(() => Promise.resolve(null))).toBeNull();
});

test("turns a problem the buyer can fix into something to tell them", async () => {
  expect(
    await failingCheckout(new PaymentUserError("Card was declined.")),
  ).toEqual({
    error: "Card was declined.",
  });
});

test("gives back nothing when the checkout breaks in a way we cannot explain", async () => {
  // There is nothing useful to tell the buyer about an unexpected break, so
  // the caller is left to report that checkout could not be started.
  expect(await failingCheckout(new Error("socket hang up"))).toBeNull();
});
