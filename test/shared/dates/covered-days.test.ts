/**
 * The days a stored `[date, endDate)` booking is present for — what the roster's
 * day picker, its day filter and the per-day email recipients all read.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { coveredDays } from "#shared/dates.ts";

describe("coveredDays", () => {
  test("a stay covers every day from its start up to its exclusive end", () => {
    expect(coveredDays("2026-03-02", "2026-03-05")).toEqual([
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
    ]);
  });

  test("one booked day is the day itself", () => {
    expect(coveredDays("2026-03-02", "2026-03-03")).toEqual(["2026-03-02"]);
  });

  test("a booking with no end recorded covers only the day it starts", () => {
    expect(coveredDays("2026-03-02", null)).toEqual(["2026-03-02"]);
  });

  test("an end that is not after the start still covers the start", () => {
    expect(coveredDays("2026-03-02", "2026-03-02")).toEqual(["2026-03-02"]);
    expect(coveredDays("2026-03-02", "2026-03-01")).toEqual(["2026-03-02"]);
  });

  test("a booking with no date covers nothing", () => {
    expect(coveredDays(null, "2026-03-05")).toEqual([]);
  });

  test("a stay crossing a month end keeps counting", () => {
    expect(coveredDays("2026-02-27", "2026-03-02")).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
  });
});
