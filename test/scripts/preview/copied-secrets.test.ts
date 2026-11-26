import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { readCopiedSecrets } from "#scripts/preview/copied-secrets.ts";

const ENV: Record<string, string> = {
  HOST_EMAIL_API_KEY: "mail-key",
  HOST_EMAIL_FROM_ADDRESS: "tickets@example.com",
  HOST_EMAIL_PROVIDER: "resend",
  STAGING_STORAGE_ZONE_KEY: "zone-key",
  STAGING_STORAGE_ZONE_NAME: "staging-zone",
};

describe("readCopiedSecrets", () => {
  test("maps the staging storage zone onto the site storage names", () => {
    const result = readCopiedSecrets((key) => ENV[key]);

    expect(result).toEqual({
      ok: true,
      value: [
        ["STORAGE_ZONE_NAME", "staging-zone"],
        ["STORAGE_ZONE_KEY", "zone-key"],
        ["HOST_EMAIL_PROVIDER", "resend"],
        ["HOST_EMAIL_API_KEY", "mail-key"],
        ["HOST_EMAIL_FROM_ADDRESS", "tickets@example.com"],
      ],
    });
  });

  test("trims each value", () => {
    const result = readCopiedSecrets((key) => ` ${ENV[key]}\n`);

    expect(result.ok && result.value[0]).toEqual([
      "STORAGE_ZONE_NAME",
      "staging-zone",
    ]);
  });

  test("names every missing or blank variable", () => {
    const result = readCopiedSecrets((key) =>
      key === "HOST_EMAIL_PROVIDER"
        ? "  "
        : key === "STAGING_STORAGE_ZONE_KEY"
          ? undefined
          : ENV[key],
    );

    expect(result).toEqual({
      error:
        "Set these secrets for the preview: STAGING_STORAGE_ZONE_KEY, HOST_EMAIL_PROVIDER.",
      ok: false,
    });
  });
});
