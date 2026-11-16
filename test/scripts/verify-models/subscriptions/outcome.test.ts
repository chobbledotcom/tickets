import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type ExpectedRefusal,
  outcomeOf,
} from "#scripts/verify-models/subscriptions/environment.ts";

const refusals: readonly ExpectedRefusal<string>[] = [
  [(error) => error instanceof RangeError, "out of range"],
  [(error) => error instanceof TypeError, "wrong type"],
];

describe("the outcome of one production call", () => {
  test("gives the result of a call that returns", async () => {
    const outcome = await outcomeOf(
      () => Promise.resolve("returned"),
      refusals,
    );
    expect(outcome).toBe("returned");
  });

  test("gives the outcome of the refusal that accepts the error", async () => {
    const outcome = await outcomeOf(
      () => Promise.reject(new TypeError("a refusal the scenario expects")),
      refusals,
    );
    expect(outcome).toBe("wrong type");
  });

  test("lets an error escape when no expected refusal accepts it", async () => {
    const fault = new Error("an unexpected fault");
    await expect(outcomeOf(() => Promise.reject(fault), refusals)).rejects.toBe(
      fault,
    );
  });
});
