import { expect } from "@std/expect";
import type { PaymentProviderType } from "#types";

type CheckoutFailureReason =
  | "invalid_response"
  | "network_error"
  | "provider_error"
  | "timeout";

type ExpectedCheckoutFailure = {
  readonly provider: PaymentProviderType;
  readonly reason: CheckoutFailureReason;
  readonly statusCode?: number | undefined;
};

/** Read one promised failure without weakening its value or type. */
const thrownFrom = async (promise: Promise<unknown>): Promise<unknown> => {
  let didThrow = false;
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    didThrow = true;
    thrown = error;
  }
  if (!didThrow) throw new Error("Expected the checkout to fail");
  return thrown;
};

/** Prove a provider failure stayed loud but crossed no free-form diagnostics. */
export const expectClosedCheckoutFailure = async (
  promise: Promise<unknown>,
  expected: ExpectedCheckoutFailure,
  privateValues: readonly string[] = [],
  original?: unknown,
): Promise<void> => {
  const thrown = await thrownFrom(promise);
  if (!(thrown instanceof Error)) throw new Error("Checkout threw a non-error");
  if (original !== undefined) expect(thrown).not.toBe(original);
  expect(thrown.name).toBe("ProviderCheckoutError");
  expect(Reflect.get(thrown, "provider")).toBe(expected.provider);
  expect(Reflect.get(thrown, "reason")).toBe(expected.reason);
  expect(Reflect.get(thrown, "statusCode")).toBe(expected.statusCode);
  expect(Reflect.get(thrown, "cause")).toBeUndefined();
  expect(Reflect.get(thrown, "requestId")).toBeUndefined();
  expect(Reflect.get(thrown, "body")).toBeUndefined();
  expect(Reflect.get(thrown, "error")).toBeUndefined();
  for (const value of privateValues) {
    expect(String(thrown)).not.toContain(value);
    expect(String(thrown.stack)).not.toContain(value);
  }
};

/** Prove an application failure was not disguised as a provider response. */
export const expectSameThrown = async (
  promise: Promise<unknown>,
  expected: unknown,
): Promise<void> => {
  expect(await thrownFrom(promise)).toBe(expected);
};
