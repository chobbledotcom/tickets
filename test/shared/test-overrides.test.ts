import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getRethrowErrors,
  getSkipLoginDelay,
  setRethrowErrors,
  setSkipLoginDelay,
} from "#shared/test-overrides.ts";

describe("test-overrides", () => {
  describe("getRethrowErrors", () => {
    test("returns null from initializer after reset", () => {
      setRethrowErrors(null);
      expect(getRethrowErrors()).toBeNull();
    });
  });

  describe("getSkipLoginDelay", () => {
    test("returns false from initializer after reset", () => {
      setSkipLoginDelay(false);
      expect(getSkipLoginDelay()).toBe(false);
    });

    test("returns false from env-based initializer when TEST_SKIP_LOGIN_DELAY is not set", () => {
      setSkipLoginDelay(null);
      expect(getSkipLoginDelay()).toBe(false);
    });
  });
});
