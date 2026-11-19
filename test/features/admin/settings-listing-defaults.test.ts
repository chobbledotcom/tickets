import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseListingDefaultsForm } from "#routes/admin/settings-listing-defaults.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { FormParams } from "#shared/form-data.ts";

const parse = (query: string, hasLogistics = true) =>
  parseListingDefaultsForm(new FormParams(query), hasLogistics);

const ok = (result: ReturnType<typeof parse>) => {
  if (result.error) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
};

describe("admin > listing defaults form parse > booleans", () => {
  test("'1' sets true, '0' sets false, blank leaves it unset", () => {
    expect(ok(parse("defaultHidden=1")).hidden).toBe(true);
    expect(ok(parse("defaultHidden=0")).hidden).toBe(false);
    expect("hidden" in ok(parse("defaultHidden="))).toBe(false);
    expect("hidden" in ok(parse(""))).toBe(false);
  });

  test("logistics default is ignored when the feature is disabled", () => {
    expect("usesLogistics" in ok(parse("defaultUsesLogistics=1", false))).toBe(
      false,
    );
    expect(ok(parse("defaultUsesLogistics=1", true)).usesLogistics).toBe(true);
  });
});

describe("admin > listing defaults form parse > numbers", () => {
  test("accepts a non-negative integer and ignores blanks", () => {
    expect(ok(parse("defaultMinimumDaysBefore=2")).minimumDaysBefore).toBe(2);
    expect(ok(parse("defaultMaximumDaysAfter=0")).maximumDaysAfter).toBe(0);
    expect("minimumDaysBefore" in ok(parse("defaultMinimumDaysBefore="))).toBe(
      false,
    );
  });

  test("rejects a non-numeric value", () => {
    const result = parse("defaultMinimumDaysBefore=abc");
    expect(result.error).not.toBeNull();
  });
});

describe("admin > listing defaults form parse > urls", () => {
  test("accepts an https url and ignores blanks", () => {
    expect(
      ok(parse("defaultWebhookUrl=https://example.com/h")).webhookUrl,
    ).toBe("https://example.com/h");
    expect("webhookUrl" in ok(parse("defaultWebhookUrl="))).toBe(false);
  });

  test("rejects an unsafe url", () => {
    expect(parse("defaultWebhookUrl=ftp://example.com").error).not.toBeNull();
    expect(parse("defaultThankYouUrl=not-a-url").error).not.toBeNull();
  });

  test("ignores the webhook default in demo mode", () => {
    setDemoModeForTest(true);
    try {
      expect(
        "webhookUrl" in ok(parse("defaultWebhookUrl=https://example.com/hook")),
      ).toBe(false);
      expect(
        ok(parse("defaultThankYouUrl=https://example.com/thanks")).thankYouUrl,
      ).toBe("https://example.com/thanks");
    } finally {
      setDemoModeForTest(false);
    }
  });
});

describe("admin > listing defaults form parse > bookable days", () => {
  test("only set when enabled, in canonical order", () => {
    const value = ok(
      parse(
        "defaultBookableDaysEnabled=1&defaultBookableDays=Wednesday&defaultBookableDays=Monday",
      ),
    );
    expect(value.bookableDays).toEqual(["Monday", "Wednesday"]);
  });

  test("unset when the enable box is off (even if days are ticked)", () => {
    expect("bookableDays" in ok(parse("defaultBookableDays=Monday"))).toBe(
      false,
    );
  });

  test("rejects a malformed day even when a valid day is also chosen", () => {
    const error = parse(
      "defaultBookableDaysEnabled=1&defaultBookableDays=Funday&defaultBookableDays=Monday",
    ).error;
    assertStringIncludes(error ?? "", "Invalid day: Funday");
    assertStringIncludes(
      error ?? "",
      "Use: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday",
    );
  });

  test("reports the first malformed day supplied", () => {
    const error = parse(
      "defaultBookableDaysEnabled=1&defaultBookableDays=Monday&defaultBookableDays=Funday&defaultBookableDays=Someday",
    ).error;
    assertStringIncludes(error ?? "", "Invalid day: Funday");
    assert(!(error ?? "").includes("Invalid day: Someday"));
  });

  test("rejects enabled with no valid day chosen", () => {
    expect(parse("defaultBookableDaysEnabled=1").error).not.toBeNull();
    expect(
      parse("defaultBookableDaysEnabled=1&defaultBookableDays=Funday").error,
    ).not.toBeNull();
  });
});

describe("admin > listing defaults form parse > combined", () => {
  test("assembles every set field and omits the rest", () => {
    const value = ok(
      parse(
        [
          "defaultUsesLogistics=1",
          "defaultHidden=0",
          "defaultMinimumDaysBefore=1",
          "defaultMaximumDaysAfter=30",
          "defaultWebhookUrl=https://example.com/hook",
          "defaultThankYouUrl=https://example.com/thanks",
          "defaultBookableDaysEnabled=1",
          "defaultBookableDays=Friday",
        ].join("&"),
      ),
    );
    expect(value).toEqual({
      bookableDays: ["Friday"],
      hidden: false,
      maximumDaysAfter: 30,
      minimumDaysBefore: 1,
      thankYouUrl: "https://example.com/thanks",
      usesLogistics: true,
      webhookUrl: "https://example.com/hook",
    });
  });

  test("an empty form clears all defaults", () => {
    expect(ok(parse(""))).toEqual({});
  });
});
