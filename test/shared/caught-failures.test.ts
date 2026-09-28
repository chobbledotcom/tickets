/** The operator-facing reporting for failures a background path caught and
 * contained: the code and detail reach the log with the original error. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  logCaughtFailure,
  logRecoveryItemFailure,
} from "#shared/caught-failures.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode } from "#shared/logger.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";

describe("caught failures", () => {
  const errorLog = setupErrorSpy();

  test("reports a caught failure with its code and detail", () => {
    logCaughtFailure(
      ErrorCode.DATA_INVALID,
      "the reply was lost",
    )(new Error("disk went away"));

    expect(errorLog.contains("the reply was lost")).toBe(true);
    expect(errorLog.contains("DATA_INVALID")).toBe(true);
  });

  test("names the recovery item and its id in the report", () => {
    const cause = new Error("Square refused");

    logRecoveryItemFailure("Square cancellation", "order_9")(cause);

    expect(errorLog.contains("Square cancellation failed for order_9")).toBe(
      true,
    );
    expect(errorLog.contains(errorMessage(cause))).toBe(true);
  });

  test("keeps reporting when the error carries no message", () => {
    logRecoveryItemFailure("Registration email", "cs_1")(undefined);

    expect(errorLog.contains("Registration email failed for cs_1")).toBe(true);
  });
});
