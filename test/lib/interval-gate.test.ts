import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import { taskIsDue } from "#shared/interval-gate.ts";

describe("taskIsDue", () => {
  test("is due when the interval has fully elapsed since the last run", () => {
    expect(taskIsDue("1000", 500, 1500)).toBe(true);
  });

  test("is due exactly at the boundary", () => {
    expect(taskIsDue("1000", 500, 1500)).toBe(true);
    expect(taskIsDue("1000", 501, 1500)).toBe(false);
  });

  test("is not due when less than the interval has passed", () => {
    expect(taskIsDue("1000", 500, 1400)).toBe(false);
  });

  test("treats an empty last-run value as never run, so it is due now", () => {
    // Empty parses to 0, so any now at least one interval past the epoch is due.
    expect(taskIsDue("", 500, 500)).toBe(true);
    expect(taskIsDue("", 500, 499)).toBe(false);
  });

  test("treats an unreadable last-run value as never run", () => {
    expect(taskIsDue("not-a-number", 500, 500)).toBe(true);
  });
});
