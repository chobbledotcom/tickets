import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  LEASE_MS,
  LEASE_SAFETY_MARGIN_MS,
  leaseTimeLeftMs,
} from "#shared/caldav/pacing.ts";

describe("leaseTimeLeftMs", () => {
  test("gives a fresh pass the full window inside the safety margin", () => {
    expect(leaseTimeLeftMs(1000, 1000)).toBe(LEASE_MS - LEASE_SAFETY_MARGIN_MS);
  });

  test("shrinks as the lease is used up", () => {
    expect(leaseTimeLeftMs(0, 20_000)).toBe(
      LEASE_MS - LEASE_SAFETY_MARGIN_MS - 20_000,
    );
  });

  test("is exactly zero at the safety-margin boundary — stop calling out", () => {
    expect(leaseTimeLeftMs(0, LEASE_MS - LEASE_SAFETY_MARGIN_MS)).toBe(0);
  });

  test("goes negative once the margin is spent", () => {
    expect(leaseTimeLeftMs(0, LEASE_MS)).toBe(-LEASE_SAFETY_MARGIN_MS);
  });
});
