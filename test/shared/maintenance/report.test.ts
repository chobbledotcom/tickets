import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { reportMaintenanceFailure } from "#shared/maintenance/report.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describe("maintenance failure reporting", () => {
  const errors = setupErrorSpy();

  test("logs the maintenance failure detail", () => {
    reportMaintenanceFailure("scheduled maintenance failed", new Error("boom"));

    expect(errors.calls.length).toBe(1);
    expect(errors.contains("scheduled maintenance failed")).toBe(true);
    expect(errors.contains("boom")).toBe(true);
  });
});
