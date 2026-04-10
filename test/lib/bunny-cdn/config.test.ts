import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  getBunnyScriptId,
  isBunnyCdnEnabled,
  isBunnyDnsEnabled,
} from "#lib/config.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv(
  "isBunnyCdnEnabled",
  { env: { BUNNY_API_KEY: undefined, BUNNY_SCRIPT_ID: undefined } },
  () => {
    test("returns false when neither env var is set", () => {
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_API_KEY is set", () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_SCRIPT_ID is set", () => {
      Deno.env.set("BUNNY_SCRIPT_ID", "123");
      expect(isBunnyCdnEnabled()).toBe(false);
    });

    test("returns true when both env vars are set", () => {
      Deno.env.set("BUNNY_API_KEY", "test-key");
      Deno.env.set("BUNNY_SCRIPT_ID", "123");
      expect(isBunnyCdnEnabled()).toBe(true);
    });
  },
);

describeWithEnv(
  "getBunnyScriptId",
  { env: { BUNNY_SCRIPT_ID: undefined } },
  () => {
    test("returns the env var value", () => {
      Deno.env.set("BUNNY_SCRIPT_ID", "42");
      expect(getBunnyScriptId()).toBe("42");
    });
  },
);

describeWithEnv(
  "isBunnyDnsEnabled",
  { env: { BUNNY_API_KEY: undefined, BUNNY_DNS_ZONE_ID: undefined } },
  () => {
    test("returns false when neither env var is set", () => {
      expect(isBunnyDnsEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_API_KEY is set", () => {
      Deno.env.set("BUNNY_API_KEY", "key");
      expect(isBunnyDnsEnabled()).toBe(false);
    });

    test("returns false when only BUNNY_DNS_ZONE_ID is set", () => {
      Deno.env.set("BUNNY_DNS_ZONE_ID", "123");
      expect(isBunnyDnsEnabled()).toBe(false);
    });

    test("returns true when both are set", () => {
      Deno.env.set("BUNNY_API_KEY", "key");
      Deno.env.set("BUNNY_DNS_ZONE_ID", "123");
      expect(isBunnyDnsEnabled()).toBe(true);
    });
  },
);
