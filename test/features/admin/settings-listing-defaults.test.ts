import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseListingDefaultsForm } from "#routes/admin/settings-listing-defaults.ts";
import { FormParams } from "#shared/form-data.ts";

const parse = (query: string, hasLogistics = true) =>
  parseListingDefaultsForm(new FormParams(query), hasLogistics);

const ok = (result: ReturnType<typeof parse>) => {
  if (result.error) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
};

describe("admin > listing defaults form parse > booleans", () => {
  test("'1' sets true, '0' sets false, blank leaves it unset", () => {
    expect(ok(parse("default_hidden=1")).hidden).toBe(true);
    expect(ok(parse("default_hidden=0")).hidden).toBe(false);
    expect("hidden" in ok(parse("default_hidden="))).toBe(false);
    expect("hidden" in ok(parse(""))).toBe(false);
  });

  test("logistics default is ignored when the feature is disabled", () => {
    expect(
      "usesLogistics" in ok(parse("default_uses_logistics=1", false)),
    ).toBe(false);
    expect(ok(parse("default_uses_logistics=1", true)).usesLogistics).toBe(
      true,
    );
  });
});

describe("admin > listing defaults form parse > numbers", () => {
  test("accepts a non-negative integer and ignores blanks", () => {
    expect(ok(parse("default_minimum_days_before=2")).minimumDaysBefore).toBe(
      2,
    );
    expect(ok(parse("default_maximum_days_after=0")).maximumDaysAfter).toBe(0);
    expect(
      "minimumDaysBefore" in ok(parse("default_minimum_days_before=")),
    ).toBe(false);
  });

  test("rejects a non-numeric value", () => {
    const result = parse("default_minimum_days_before=abc");
    expect(result.error).not.toBeNull();
  });
});

describe("admin > listing defaults form parse > urls", () => {
  test("accepts an https url and ignores blanks", () => {
    expect(
      ok(parse("default_webhook_url=https://example.com/h")).webhookUrl,
    ).toBe("https://example.com/h");
    expect("webhookUrl" in ok(parse("default_webhook_url="))).toBe(false);
  });

  test("rejects an unsafe url", () => {
    expect(parse("default_webhook_url=ftp://example.com").error).not.toBeNull();
    expect(parse("default_thank_you_url=not-a-url").error).not.toBeNull();
  });
});

describe("admin > listing defaults form parse > bookable days", () => {
  test("only set when enabled, in canonical order", () => {
    const value = ok(
      parse(
        "default_bookable_days_enabled=1&default_bookable_days=Wednesday&default_bookable_days=Monday",
      ),
    );
    expect(value.bookableDays).toEqual(["Monday", "Wednesday"]);
  });

  test("unset when the enable box is off (even if days are ticked)", () => {
    expect("bookableDays" in ok(parse("default_bookable_days=Monday"))).toBe(
      false,
    );
  });

  test("keeps the valid ticked days and drops invalid ones", () => {
    const value = ok(
      parse(
        "default_bookable_days_enabled=1&default_bookable_days=Funday&default_bookable_days=Monday",
      ),
    );
    expect(value.bookableDays).toEqual(["Monday"]);
  });

  test("rejects enabled with no valid day chosen", () => {
    expect(parse("default_bookable_days_enabled=1").error).not.toBeNull();
    expect(
      parse("default_bookable_days_enabled=1&default_bookable_days=Funday")
        .error,
    ).not.toBeNull();
  });
});

describe("admin > listing defaults form parse > combined", () => {
  test("assembles every set field and omits the rest", () => {
    const value = ok(
      parse(
        [
          "default_uses_logistics=1",
          "default_hidden=0",
          "default_minimum_days_before=1",
          "default_maximum_days_after=30",
          "default_webhook_url=https://example.com/hook",
          "default_thank_you_url=https://example.com/thanks",
          "default_bookable_days_enabled=1",
          "default_bookable_days=Friday",
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
