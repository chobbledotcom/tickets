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

  test("ensureGuideMessages loads the guide bundle so guide keys resolve", async () => {
    await ensureGuideMessages();
    expect(t("guide.title")).toBe("Guide");
  });

  test("ensureGuideMessages is idempotent (safe to await on every guide request)", async () => {
    await ensureGuideMessages();
    await ensureGuideMessages();
    expect(t("guide.title")).toBe("Guide");
  });
});
