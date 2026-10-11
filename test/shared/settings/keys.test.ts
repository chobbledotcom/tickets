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
      "4e6f155d0d091bf9512da8de5efab87f2f2cf57cf0947aa7f87f326126409041",
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
