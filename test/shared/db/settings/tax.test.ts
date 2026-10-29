import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getCurrentSettingsVersion } from "#db/settings/cache.ts";
import { parseTaxPolicy, serializeTaxPolicy } from "#db/settings/tax.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
import { NO_TAX, type TaxPolicy } from "#shared/tax/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > tax settings", { db: true }, () => {
  test("tax saves preserve other settings already loaded in the same request", async () => {
    await settings.loadKeys([CONFIG_KEYS.PUBLIC_KEY, CONFIG_KEYS.CUSTOM_CSS]);
    const publicKey = settings.publicKey;
    expect(publicKey).not.toBe("");
    await settings.update.customCss("body { color: green; }");
    await settings.update.tax(
      { mode: "add_to_total", rateBasisPoints: 2000 },
      NO_TAX,
    );
    expect(settings.publicKey).toBe(publicKey);
    expect(settings.customCss).toBe("body { color: green; }");
    expect(settings.getCachedRaw(CONFIG_KEYS.PUBLIC_KEY)).toBe(publicKey);
    expect(settings.tax).toEqual({
      mode: "add_to_total",
      rateBasisPoints: 2000,
    });
  });
  test("canonical serialization ignores input property order", () => {
    expect(
      serializeTaxPolicy({
        mode: "calculate_from_total",
        rateBasisPoints: 725,
      }),
    ).toBe('{"mode":"calculate_from_total","rateBasisPoints":725}');
    expect(parseTaxPolicy("")).toEqual(NO_TAX);
  });

  test("a successful write advances the shared settings version", async () => {
    const version = await getCurrentSettingsVersion();
    await settings.update.tax({ mode: "add_to_total", rateBasisPoints: 725 });
    expect(await getCurrentSettingsVersion()).toBe(version + 1);
  });

  test("runtime-invalid policy writes leave the policy and version unchanged", async () => {
    await settings.update.tax(NO_TAX);
    const version = await getCurrentSettingsVersion();
    for (const rateBasisPoints of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      await expect(
        settings.update.tax({ mode: "add_to_total", rateBasisPoints }),
      ).rejects.toThrow();
    }
    expect(settings.tax).toEqual(NO_TAX);
    expect(await getCurrentSettingsVersion()).toBe(version);
  });

  test("only one competing save can use the same expected policy", async () => {
    await settings.update.tax(NO_TAX);
    const results = await Promise.all([
      settings.update.tax(
        { mode: "add_to_total", rateBasisPoints: 1000 },
        NO_TAX,
      ),
      settings.update.tax(
        { mode: "calculate_from_total", rateBasisPoints: 2000 },
        NO_TAX,
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  test("missing and empty values mean No tax", async () => {
    await settings.loadKeys([CONFIG_KEYS.TAX]);
    expect(settings.tax).toEqual(NO_TAX);
    await settings.setRaw(CONFIG_KEYS.TAX, "");
    settings.invalidateCache();
    await settings.loadKeys([CONFIG_KEYS.TAX]);
    expect(settings.tax).toEqual(NO_TAX);
  });

  for (const policy of [
    NO_TAX,
    { mode: "add_to_total", rateBasisPoints: 0 },
    { mode: "add_to_total", rateBasisPoints: 2001 },
    { mode: "calculate_from_total", rateBasisPoints: 725 },
  ] satisfies TaxPolicy[]) {
    test(`saves and reloads ${JSON.stringify(policy)} as plaintext`, async () => {
      expect(await settings.update.tax(policy)).toBe(true);
      expect(settings.tax).toEqual(policy);
      expect(settings.getCachedRaw(CONFIG_KEYS.TAX)).toBe(
        JSON.stringify(policy),
      );
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.TAX]);
      expect(settings.tax).toEqual(policy);
    });
  }

  test("stale expected policies do not change stored money policy or version", async () => {
    const policy = { mode: "add_to_total", rateBasisPoints: 2000 } as const;
    await settings.update.tax(policy);
    const version = await getCurrentSettingsVersion();
    expect(await settings.update.tax(NO_TAX, NO_TAX)).toBe(false);
    expect(settings.tax).toEqual(policy);
    expect(await getCurrentSettingsVersion()).toBe(version);
    settings.invalidateCache();
    await settings.loadKeys([CONFIG_KEYS.TAX]);
    expect(settings.tax).toEqual(policy);
  });

  test("compares the database rather than a stale snapshot", async () => {
    await settings.update.tax(NO_TAX);
    settings.setForTest({ tax: JSON.stringify(NO_TAX) });
    try {
      await settings.setRaw(
        CONFIG_KEYS.TAX,
        '{"rateBasisPoints":1000,"mode":"add_to_total"}',
      );
      expect(await settings.update.tax(NO_TAX, NO_TAX)).toBe(false);
      expect(
        await settings.update.tax(NO_TAX, {
          mode: "add_to_total",
          rateBasisPoints: 1000,
        }),
      ).toBe(true);
    } finally {
      settings.clearTestOverride("tax");
    }
  });

  for (const stored of [
    "{",
    "null",
    '{"mode":"wat"}',
    '{"mode":"none","rateBasisPoints":0}',
    '{"mode":"add_to_total","rateBasisPoints":-1}',
    '{"mode":"add_to_total","rateBasisPoints":1.5}',
  ]) {
    test(`rejects malformed stored policy ${stored}`, async () => {
      await settings.setRaw(CONFIG_KEYS.TAX, stored);
      settings.invalidateCache();
      await settings.loadKeys([CONFIG_KEYS.TAX]);
      expect(() => settings.tax).toThrow();
      await expect(settings.update.tax(NO_TAX)).rejects.toThrow();
    });
  }
});
