import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  callDeadlineMs,
  canStartCall,
  LEASE_MS,
  LEASE_SAFETY_MARGIN_MS,
} from "#shared/caldav/pacing.ts";

describe("canStartCall", () => {
  test("allows a call at the very start of the lease", () => {
    expect(canStartCall(1000, 1000)).toBe(true);
  });

  test("allows a call right at the safety-margin boundary", () => {
    const started = 1000;
    const boundary = started + LEASE_MS - LEASE_SAFETY_MARGIN_MS;
    expect(canStartCall(started, boundary)).toBe(true);
  });

  test("stops calls one millisecond past the safety-margin boundary", () => {
    const started = 1000;
    const boundary = started + LEASE_MS - LEASE_SAFETY_MARGIN_MS;
    expect(canStartCall(started, boundary + 1)).toBe(false);
  });

  test("respects a custom lease and margin instead of the defaults", () => {
    // 20ms lease, 5ms margin: calls allowed up to 15ms elapsed, blocked after.
    expect(canStartCall(0, 15, 20, 5)).toBe(true);
    expect(canStartCall(0, 16, 20, 5)).toBe(false);
  });
});

describe("callDeadlineMs", () => {
  test("gives a fresh call the full window inside the margin", () => {
    expect(callDeadlineMs(1000, 1000)).toBe(LEASE_MS - LEASE_SAFETY_MARGIN_MS);
  });

  test("shrinks the window as the lease is used up", () => {
    expect(callDeadlineMs(0, 20_000)).toBe(
      LEASE_MS - LEASE_SAFETY_MARGIN_MS - 20_000,
    );
  });

  test("never returns a negative deadline once the margin is spent", () => {
    expect(callDeadlineMs(0, LEASE_MS)).toBe(0);
    expect(callDeadlineMs(0, LEASE_MS + 5_000)).toBe(0);
  });
});
