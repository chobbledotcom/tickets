import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { checkVerification } from "#scripts/check-tla/run.ts";
import { verificationModuleFor } from "#scripts/verify-models/registry.ts";
import { dataFileName, sourceFileFor } from "#scripts/verify-models/spec.ts";
import { registeredModel } from "./registered-model.ts";

test("every maintained model and helper meets the source policy", async () => {
  const errors: string[] = [];
  const result = await checkVerification({
    log: () => {},
    logError: (line) => errors.push(line),
  });
  expect({ errors, result }).toEqual({ errors: [], result: 0 });
});

test("a source file with no declaration is refused", () => {
  expect(() => verificationModuleFor("verification/Unregistered.qnt")).toThrow(
    /no declaration: verification\/Unregistered\.qnt/,
  );
  expect(
    verificationModuleFor(sourceFileFor("VatLedger", "quint")),
  ).toMatchObject({ language: "quint", module: "VatLedger" });
});

test("the fact module sits beside its model with the language extension", () => {
  expect(dataFileName("VatLedger", "quint")).toBe("VatLedgerData.qnt");
  expect(dataFileName("DoorScan", "tla")).toBe("DoorScanData.tla");
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
