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
  "builder host secrets by provider",
  {
    env: {
      BUNNY_API_KEY: "host-key",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
      BUNNY_DNS_ZONE_ID: "zone-1",
      NTFY_URL: "https://ntfy.example.com/t",
    },
  },
  () => {
    test("copies the exact allowed configured values", () => {
      const relevantNames = new Set([
        "BUNNY_API_KEY",
        "BUNNY_DNS_SUBDOMAIN_SUFFIX",
        "BUNNY_DNS_ZONE_ID",
        "NTFY_URL",
      ]);
      const selected = (provider: "bunny" | "deno") =>
        Object.fromEntries(
          collectHostSecrets(provider).filter(([name]) =>
            relevantNames.has(name),
          ),
        );

      expect({ bunny: selected("bunny"), deno: selected("deno") }).toEqual({
        bunny: {
          BUNNY_API_KEY: "host-key",
          BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
          BUNNY_DNS_ZONE_ID: "zone-1",
          NTFY_URL: "https://ntfy.example.com/t",
        },
        deno: { NTFY_URL: "https://ntfy.example.com/t" },
      });
    });
  },
);
