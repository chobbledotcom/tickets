import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkVerification } from "#scripts/check-tla/run.ts";
import { registeredModel } from "./registered-model.ts";

test("every maintained model and helper meets the source policy", async () => {
  const errors: string[] = [];
  const result = await checkVerification({
    log: () => {},
    logError: (line) => errors.push(line),
  });
  expect({ errors, result }).toEqual({ errors: [], result: 0 });
});

test("data consumers refuse an undeclared model instead of producing unrelated facts", () => {
  expect(() => registeredModel("UnregisteredCheckout").data()).toThrow(
    /no declaration.*UnregisteredCheckout/,
  );
});

test("a helper cannot be consumed as a model fact source", () => {
  expect(() => registeredModel("ModelRules").data()).toThrow(
    /declares no model facts/,
  );
});
