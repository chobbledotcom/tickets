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
      "2faabd2086665d5a689665f6cbdf025266d31a5d3e5285b25bca6cd0910c29e1",
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
