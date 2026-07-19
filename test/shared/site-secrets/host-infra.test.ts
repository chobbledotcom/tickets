import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hostInfraSecretNames } from "#shared/site-secrets.ts";

test("keeps only host-level infrastructure credential names", () => {
  expect(
    hostInfraSecretNames([
      "NTFY_URL",
      "BUNNY_API_KEY",
      "DB_URL",
      "STORAGE_ZONE_KEY",
      "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
    ]),
  ).toEqual([
    "BUNNY_API_KEY",
    "STORAGE_ZONE_KEY",
    "GOOGLE_WALLET_SERVICE_ACCOUNT_KEY",
  ]);
});

test("returns an empty list for low-privilege names", () => {
  expect(
    hostInfraSecretNames(["NTFY_URL", "DB_URL", "BUNNY_SCRIPT_ID"]),
  ).toEqual([]);
});
