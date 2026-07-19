import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { collectHostSecrets, HOST_INFRA_SECRET_KEYS } from "#shared/builder.ts";
import { describeWithEnv } from "#test-utils/db.ts";

test("lists every high-privilege host credential", () => {
  expect(HOST_INFRA_SECRET_KEYS).toEqual([
    "STORAGE_ZONE_NAME",
    "STORAGE_ZONE_KEY",
    "HOST_EMAIL_API_KEY",
    "BUNNY_API_KEY",
    "BUNNY_DNS_ZONE_ID",
    "APPLE_WALLET_SIGNING_CERT",
    "APPLE_WALLET_SIGNING_KEY",
    "APPLE_WALLET_WWDR_CERT",
    "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
  ]);
});

describeWithEnv(
  "builder host secrets",
  {
    env: {
      BUNNY_API_KEY: "host-key",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
      BUNNY_DNS_ZONE_ID: "zone-1",
      NTFY_URL: "https://ntfy.example.com/t",
    },
  },
  () => {
    test("keeps shared secrets and excludes Bunny-only secrets for Deno", () => {
      const names = collectHostSecrets("deno").map(([name]) => name);
      expect(names).toContain("NTFY_URL");
      expect(names).not.toContain("BUNNY_API_KEY");
      expect(names).not.toContain("BUNNY_DNS_ZONE_ID");
      expect(names).not.toContain("BUNNY_DNS_SUBDOMAIN_SUFFIX");
    });

    test("includes Bunny-only secrets for Bunny", () => {
      const names = collectHostSecrets("bunny").map(([name]) => name);
      expect(names).toContain("BUNNY_API_KEY");
      expect(names).toContain("BUNNY_DNS_ZONE_ID");
      expect(names).toContain("BUNNY_DNS_SUBDOMAIN_SUFFIX");
    });
  },
);

describeWithEnv(
  "builder host secrets with one configured value",
  { env: { NTFY_URL: "https://ntfy.example.com/t" } },
  () => {
    test("includes configured values and skips missing values", () => {
      const pairs = collectHostSecrets();
      expect(pairs).toContainEqual(["NTFY_URL", "https://ntfy.example.com/t"]);
      expect(pairs.map(([name]) => name)).not.toContain("STORAGE_ZONE_KEY");
    });
  },
);
