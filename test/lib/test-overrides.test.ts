import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getRethrowErrors,
  getSkipLoginDelay,
  setRethrowErrorsForTest,
  setSkipLoginDelayForTest,
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
  });
});
