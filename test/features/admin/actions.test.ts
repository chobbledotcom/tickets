import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  csvResponse,
  getDateFilter,
  getMonthFilter,
} from "#routes/admin/actions.ts";
import { mockRequest } from "#test-utils/mocks.ts";

const asked = (query: string): Request =>
  mockRequest(`/admin/attendees${query}`);

describe("getDateFilter", () => {
  test("keeps a date that reads as a real one", () => {
    expect(getDateFilter(asked("?date=2026-07-04"))).toBe("2026-07-04");
  });

  test("treats a date nobody could have meant as absent", () => {
    expect(getDateFilter(asked("?date=2026-13-40"))).toBeNull();
  });

  test("treats junk as absent, so a typed URL cannot filter by it", () => {
    expect(getDateFilter(asked("?date=yesterday"))).toBeNull();
  });

  test("is absent when the parameter is empty", () => {
    expect(getDateFilter(asked("?date="))).toBeNull();
  });

  test("is absent when the parameter is not there", () => {
    expect(getDateFilter(asked(""))).toBeNull();
  });

  test("reads its own parameter, not the month's", () => {
    expect(getDateFilter(asked("?cal=2026-07"))).toBeNull();
  });
});

describe("getMonthFilter", () => {
  test("keeps a month that reads as a real one", () => {
    expect(getMonthFilter(asked("?cal=2026-07"))).toBe("2026-07");
  });

  test("treats a whole date as absent, because it asks for a month", () => {
    expect(getMonthFilter(asked("?cal=2026-07-04"))).toBeNull();
  });

  test("treats a month nobody could have meant as absent", () => {
    expect(getMonthFilter(asked("?cal=2026-13"))).toBeNull();
  });

  test("reads its own parameter, not the date's", () => {
    expect(getMonthFilter(asked("?date=2026-07-04"))).toBeNull();
  });
});

describe("csvResponse", () => {
  test("names the download and marks it as CSV text", () => {
    const response = csvResponse("a,b\n1,2\n", "attendees.csv");
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="attendees.csv"',
    );
  });

  test("carries the rows through unchanged", async () => {
    expect(await csvResponse("a,b\n1,2\n", "x.csv").text()).toBe("a,b\n1,2\n");
  });
});
