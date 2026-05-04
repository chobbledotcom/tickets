import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("settings.theme from DB", { db: true }, () => {
  beforeEach(() => {
    settings.clearTestOverride("theme");
  });

  test("loads light theme from database by default", () => {
    expect(settings.theme).toBe("light");
  });

  test("loads dark theme after updating database", async () => {
    await settings.update.theme("dark");
    expect(settings.theme).toBe("dark");
  });
});
