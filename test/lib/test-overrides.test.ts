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
      setRethrowErrorsForTest(null);
      expect(getRethrowErrors()).toBeNull();
    });
  });

  describe("getSkipLoginDelay", () => {
    test("returns false from initializer after reset", () => {
      setSkipLoginDelayForTest(false);
      expect(getSkipLoginDelay()).toBe(false);
    });
  });
});
