import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { registerMessages, t } from "#i18n";
import en from "#locales/en/index.ts";
import { ensureGuideMessages } from "#shared/guide-messages.ts";

/**
 * The admin guide's ~120KB of translations are loaded on demand and merged into
 * `en`, instead of shipping in the eager `en` map that loads on every cold boot.
 * These tests lock in that split (the boot win) and the load mechanism.
 */
describe("guide messages (lazy loaded)", () => {
  test("guide keys are kept OUT of the eager en merge (off the cold-boot path)", () => {
    // The regression this guards: re-adding guide.json to src/locales/en/index.ts
    // would put its weight back on every cold boot.
    expect("guide.title" in en).toBe(false);
    expect("guide.a.what_is_purchase_only_mode" in en).toBe(false);
  });

  test("registerMessages merges extra keys without dropping existing ones", () => {
    registerMessages("en", { "guide_messages_test.probe": "Probe OK" });
    // The newly registered key resolves…
    expect(t("guide_messages_test.probe")).toBe("Probe OK");
    // …and pre-existing keys are preserved (guards a mutant that spreads only
    // the new keys and discards the current map).
    expect(t("common.yes")).toBe("Yes");
  });

  test("registerMessages clears a cached miss so a late-registered key resolves", () => {
    const key = "guide_messages_test.registered_late";
    // A lookup before registration caches the key as a miss (t throws)…
    expect(() => t(key)).toThrow(`Missing translation for key "${key}"`);
    // …and registering it must clear that cached miss, not leave the key
    // poisoned as null for the rest of the isolate's life.
    registerMessages("en", { [key]: "Arrived late" });
    expect(t(key)).toBe("Arrived late");
  });

  test("ensureGuideMessages loads the guide bundle so guide keys resolve", async () => {
    await ensureGuideMessages();
    expect(t("guide.title")).toBe("Guide");
  });

  test("ensureGuideMessages memoizes, so it registers the bundle only once", () => {
    // once() hands back the same promise on every call, so the dynamic import +
    // registration side effect runs a single time no matter how many guide
    // requests await it — independent of suite order or shared i18n state.
    expect(ensureGuideMessages()).toBe(ensureGuideMessages());
  });
});
