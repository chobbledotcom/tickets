import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { CONFIG_KEY_NAMES, CONFIG_KEYS } from "#shared/settings/keys.ts";
import { jsonHash } from "#test-utils/hash.ts";

describe("settings keys", () => {
  test("maps every key name to its lowercase stored value", () => {
    expect(Object.values(CONFIG_KEYS)).toEqual(
      CONFIG_KEY_NAMES.map((name) => name.toLowerCase()),
    );
  });

  test("keeps the complete public key catalog exact", async () => {
    expect(await jsonHash(CONFIG_KEY_NAMES)).toBe(
      "e3d709e6b5b9e1808d730fc2f5c4d45c51bde7a52056f116735d0cdd90f86a7f",
    );
  });

  test("does not register retired maintenance timestamps", () => {
    expect(
      Object.keys(CONFIG_KEYS).filter(
        (name) =>
          name.startsWith("LAST_PRUNED_") ||
          name === "LAST_ACTIVITY_LOG_BACKFILL" ||
          name === "ACTIVITY_LOG_BACKFILL_DONE",
      ),
    ).toEqual([]);
  });
});
