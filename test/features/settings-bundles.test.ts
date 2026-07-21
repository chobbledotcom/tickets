import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getPrefix, settingsForPath } from "#routes/settings-bundles.ts";
import { CONFIG_KEYS } from "#shared/db/settings.ts";

describe("settings bundles", () => {
  test("extracts the first path segment without its leading slash", () => {
    expect(getPrefix("/admin/settings")).toBe("admin");
  });

  test("loads the schema hash for admin routes", () => {
    expect(settingsForPath("/admin")).toContain("db_schema_hash");
  });

  test("keeps the home page bundle narrower than the full settings list", () => {
    expect(settingsForPath("/")).not.toContain(
      CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
    );
  });

  test("uses the full settings list for inherited object property names", () => {
    expect(settingsForPath("/constructor")).toContain(
      CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
    );
  });

  test("does not reserve a settings bundle for the early scheduled route", () => {
    expect(settingsForPath("/scheduled")).toContain(
      CONFIG_KEYS.APPLE_WALLET_SIGNING_KEY,
    );
  });
});
