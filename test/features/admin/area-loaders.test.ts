import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { GUIDE_MESSAGE_GROUPS } from "#locales/manifest.ts";
import { ADMIN_AREA_LOADERS } from "#routes/admin/area-loaders.ts";

describe("admin area message groups", () => {
  test("loads table copy for the complete guide", () => {
    expect(ADMIN_AREA_LOADERS.guide.messageGroupsFor("guide")).toEqual([
      "attendees",
      "builder",
      "listings-table",
      ...GUIDE_MESSAGE_GROUPS,
    ]);
  });

  test("loads only formatting copy for the formatting guide", () => {
    expect(ADMIN_AREA_LOADERS.guide.messageGroupsFor("formatting")).toEqual([
      "guide-formatting",
    ]);
  });

  test("rejects an undeclared guide segment", () => {
    expect(() => ADMIN_AREA_LOADERS.guide.messageGroupsFor("missing")).toThrow(
      'No message groups declared for admin segment "missing"',
    );
  });
});
