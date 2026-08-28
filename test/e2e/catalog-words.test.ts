import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { catalogWords } from "#e2e/catalog-words.ts";

describe("catalog words", () => {
  test("renders a plain message from its group", async () => {
    await expect(catalogWords("common", "common.save_changes")).resolves.toBe(
      "Save Changes",
    );
  });

  test("renders a message with values filled in", async () => {
    await expect(
      catalogWords("settings", "settings.provider.update_credentials", {
        provider: "Stripe",
      }),
    ).resolves.toBe("Update Stripe credentials");
  });

  test("raises when the key names nothing", async () => {
    await expect(catalogWords("common", "common.gone")).rejects.toThrow(
      'Missing translation for key "common.gone"',
    );
  });
});
