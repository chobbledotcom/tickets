import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  ErrorCode,
  type ErrorCodeType,
  type ErrorContext,
  errorCodeLabel,
  formatErrorMessage,
  formatRequestError,
} from "#shared/logger.ts";

describe("errorCodeLabel", () => {
  test("has a label for every error code", () => {
    for (const code of Object.values(ErrorCode)) {
      expect(errorCodeLabel[code as ErrorCodeType]).toBeDefined();
    }
  });

  test("all labels are non-empty strings", () => {
    for (const label of Object.values(errorCodeLabel)) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("formatErrorMessage", () => {
  test("formats error with detail", () => {
    const context: ErrorContext = {
      code: ErrorCode.STRIPE_CHECKOUT,
      detail: "timeout",
    };
    expect(formatErrorMessage(context)).toBe(
      "Error: Stripe checkout failed (timeout)",
    );
  });

  test("formats error without detail", () => {
    const context: ErrorContext = { code: ErrorCode.DB_CONNECTION };
    expect(formatErrorMessage(context)).toBe(
      "Error: Database connection failed",
    );
  });

  test("ignores eventId (metadata only for log routing)", () => {
    const context: ErrorContext = {
      code: ErrorCode.PAYMENT_SESSION,
      detail: "price mismatch",
      eventId: 42,
    };
    expect(formatErrorMessage(context)).toBe(
      "Error: Payment session error (price mismatch)",
    );
    expect(formatErrorMessage(context)).not.toContain("42");
  });
});

describe("formatRequestError", () => {
  test("formats Error instance with message", () => {
    expect(
      formatRequestError("GET", "/ticket/abc", new Error("DB timeout")),
    ).toBe("GET /ticket/[redacted]: DB timeout");
  });

  test("formats non-Error value as string", () => {
    expect(
      formatRequestError("POST", "/admin/events/5", "connection reset"),
    ).toBe("POST /admin/events/[id]: connection reset");
  });

  test("redacts path in the output", () => {
    const result = formatRequestError(
      "GET",
      "/checkin/secret-token",
      new Error("fail"),
    );
    expect(result).not.toContain("secret-token");
    expect(result).toContain("[redacted]");
  });
});
