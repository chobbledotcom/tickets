import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { appendItemSchedule, escapeIcs, formatIcsDate } from "#shared/ics.ts";

describe("escapeIcs", () => {
  test("escapes a backslash", () => {
    expect(escapeIcs("a\\b")).toBe("a\\\\b");
  });

  test("escapes a semicolon", () => {
    expect(escapeIcs("a;b")).toBe("a\\;b");
  });

  test("escapes a comma", () => {
    expect(escapeIcs("a,b")).toBe("a\\,b");
  });

  test("escapes a newline", () => {
    expect(escapeIcs("a\nb")).toBe("a\\nb");
  });

  test("escapes every special character together", () => {
    expect(escapeIcs("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });

  test("normalizes a Windows CRLF to a single escaped newline", () => {
    // Regression: a stored value with \r\n must not leak a raw carriage
    // return into the content line.
    expect(escapeIcs("line one\r\nline two")).toBe("line one\\nline two");
  });

  test("normalizes a bare carriage return to an escaped newline", () => {
    expect(escapeIcs("line one\rline two")).toBe("line one\\nline two");
  });
});

describe("formatIcsDate", () => {
  test("formats an ISO instant as a compact UTC timestamp", () => {
    expect(formatIcsDate("2026-08-10T09:30:00.000Z")).toBe("20260810T093000Z");
  });
});

describe("appendItemSchedule", () => {
  test("adds DTSTART and LOCATION when both are present", () => {
    const lines: string[] = [];
    appendItemSchedule(lines, {
      date: "2026-08-10T09:30:00.000Z",
      location: "Main Hall",
    });
    expect(lines).toEqual(["DTSTART:20260810T093000Z", "LOCATION:Main Hall"]);
  });

  test("omits DTSTART when there is no date", () => {
    const lines: string[] = [];
    appendItemSchedule(lines, { date: null, location: "Main Hall" });
    expect(lines).toEqual(["LOCATION:Main Hall"]);
  });

  test("omits LOCATION when it is empty, and escapes it when present", () => {
    const lines: string[] = [];
    appendItemSchedule(lines, {
      date: "2026-08-10T09:30:00.000Z",
      location: "A, B",
    });
    expect(lines).toEqual(["DTSTART:20260810T093000Z", "LOCATION:A\\, B"]);
  });
});
