import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import {
  getBotpoisonPublicKey,
  getBotpoisonSecretKey,
  getBunnyApiKey,
  getBunnyDnsSubdomainSuffix,
  getBunnyDnsZoneId,
  getBunnyScriptId,
  getDebugKey,
  getDefaultDbProvider,
  getDenoDeployOrgId,
  getDenoDeployOrgSlug,
  getDenoDeployToken,
  getMainInstanceKey,
  getTursoApiToken,
  getTursoGroup,
  getTursoOrganization,
  isBotpoisonEnabled,
  isBuilderEnabled,
  isBunnyCdnEnabled,
  isBunnyDbEnabled,
  isBunnyDnsEnabled,
  isDenoDeployEnabled,
  isInstanceApiEnabled,
  isSecureMode,
  isTursoEnabled,
  resetEffectiveDomain,
  seedEffectiveDomainHost,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { withEnv } from "#test-utils/env.ts";

type BoolGetter = () => boolean;
type StringGetter = () => string;
type MissingValueCheck = {
  readonly name: string;
  readonly check: (getValue: StringGetter, key: string) => void;
};

const expectEnvGetter =
  (missing: MissingValueCheck) =>
  (name: string, getValue: StringGetter, key: string, value: string) => {
    describe(name, () => {
      test("returns the configured value", () => {
        using _env = withEnv({ [key]: value });
        expect(getValue()).toBe(value);
      });

      test(missing.name, () => {
        using _env = withEnv({ [key]: undefined });
        missing.check(getValue, key);
      });
    });
  };

const expectRequiredEnvGetter = expectEnvGetter({
  check: (getValue, key) => {
    expect(getValue).toThrow(`Required environment variable ${key} is not set`);
  },
  name: "throws when the required value is missing",
});

const expectOptionalEnvGetter = expectEnvGetter({
  check: (getValue) => {
    expect(getValue()).toBe("");
  },
  name: "returns an empty string when unset",
});

const expectEnabledByAllKeys = (
  name: string,
  isEnabled: BoolGetter,
  keys: string[],
) => {
  describe(name, () => {
    const allKeysSet = Object.fromEntries(
      keys.map((key) => [key, `${key.toLowerCase()}_value`]),
    );

    test("returns true when every required value is set", () => {
      using _env = withEnv(allKeysSet);
      expect(isEnabled()).toBe(true);
    });

    for (const missingKey of keys) {
      test(`returns false when ${missingKey} is missing`, () => {
        using _env = withEnv({ ...allKeysSet, [missingKey]: undefined });
        expect(isEnabled()).toBe(false);
      });
    }
  });
};

describe("isSecureMode", () => {
  afterEach(() => resetEffectiveDomain());

  const localHosts = [
    "localhost",
    "admin.localhost",
    "127.0.0.1",
    "127.255.255.255",
    "[::1]",
    "::1",
  ];

  for (const host of localHosts) {
    test(`returns false for ${host}`, () => {
      setEffectiveDomainForTest(host);
      expect(isSecureMode()).toBe(false);
    });
  }

  const secureHosts = [
    "example.com",
    "not-localhost.example",
    "128.0.0.1",
    "127.0.0",
    "127.0.one.1",
    "127.0.0.256",
  ];

  for (const host of secureHosts) {
    test(`returns true for ${host}`, () => {
      setEffectiveDomainForTest(host);
      expect(isSecureMode()).toBe(true);
    });
  }

  test("seeds a real host through a URL and keeps secure mode on", () => {
    seedEffectiveDomainHost(new URL("http://tickets.example.com:3000/"));
    expect(isSecureMode()).toBe(true);
    seedEffectiveDomainHost(new URL("http://[::1]:3000/"));
    expect(isSecureMode()).toBe(false);
  });

  test("stays on for forged loopback shapes a URL cannot parse", () => {
    for (const host of ["127.0.0.1.5", "127.0.1e2.1"]) {
      setEffectiveDomainForTest(host);
      expect(isSecureMode(), host).toBe(true);
    }
  });
});

expectEnabledByAllKeys("isBunnyCdnEnabled", isBunnyCdnEnabled, [
  "BUNNY_API_KEY",
  "BUNNY_SCRIPT_ID",
]);

expectEnabledByAllKeys("isBunnyDnsEnabled", isBunnyDnsEnabled, [
  "BUNNY_API_KEY",
  "BUNNY_DNS_ZONE_ID",
]);

describe("isBunnyDbEnabled", () => {
  test("returns true when the API key is set", () => {
    using _env = withEnv({ BUNNY_API_KEY: "bunny_key" });
    expect(isBunnyDbEnabled()).toBe(true);
  });

  test("returns false when the API key is missing", () => {
    using _env = withEnv({ BUNNY_API_KEY: undefined });
    expect(isBunnyDbEnabled()).toBe(false);
  });
});

expectRequiredEnvGetter(
  "getBunnyApiKey",
  getBunnyApiKey,
  "BUNNY_API_KEY",
  "bunny_key",
);
expectRequiredEnvGetter(
  "getBunnyDnsZoneId",
  getBunnyDnsZoneId,
  "BUNNY_DNS_ZONE_ID",
  "zone_123",
);
expectOptionalEnvGetter(
  "getBunnyDnsSubdomainSuffix",
  getBunnyDnsSubdomainSuffix,
  "BUNNY_DNS_SUBDOMAIN_SUFFIX",
  ".tickets",
);
expectRequiredEnvGetter(
  "getBunnyScriptId",
  getBunnyScriptId,
  "BUNNY_SCRIPT_ID",
  "script_123",
);
expectOptionalEnvGetter("getDebugKey", getDebugKey, "DEBUG_KEY", "debug_key");

expectOptionalEnvGetter(
  "getBotpoisonPublicKey",
  getBotpoisonPublicKey,
  "BOTPOISON_PUBLIC_KEY",
  "botpoison_public",
);
expectOptionalEnvGetter(
  "getBotpoisonSecretKey",
  getBotpoisonSecretKey,
  "BOTPOISON_SECRET_KEY",
  "botpoison_secret",
);
expectEnabledByAllKeys("isBotpoisonEnabled", isBotpoisonEnabled, [
  "BOTPOISON_PUBLIC_KEY",
  "BOTPOISON_SECRET_KEY",
]);

describe("isInstanceApiEnabled", () => {
  test("returns true when the main instance key is set", () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: "main_key" });
    expect(isInstanceApiEnabled()).toBe(true);
  });

  test("returns false when the main instance key is missing", () => {
    using _env = withEnv({ MAIN_INSTANCE_KEY: undefined });
    expect(isInstanceApiEnabled()).toBe(false);
  });
});

expectRequiredEnvGetter(
  "getMainInstanceKey",
  getMainInstanceKey,
  "MAIN_INSTANCE_KEY",
  "main_key",
);

expectEnabledByAllKeys("isDenoDeployEnabled", isDenoDeployEnabled, [
  "DENO_DEPLOY_TOKEN",
  "DENO_DEPLOY_ORG_ID",
  "DENO_DEPLOY_ORG_SLUG",
]);
expectRequiredEnvGetter(
  "getDenoDeployToken",
  getDenoDeployToken,
  "DENO_DEPLOY_TOKEN",
  "deploy_token",
);
expectRequiredEnvGetter(
  "getDenoDeployOrgId",
  getDenoDeployOrgId,
  "DENO_DEPLOY_ORG_ID",
  "deploy_org",
);
expectRequiredEnvGetter(
  "getDenoDeployOrgSlug",
  getDenoDeployOrgSlug,
  "DENO_DEPLOY_ORG_SLUG",
  "deploy-org",
);

describe("getDefaultDbProvider", () => {
  test("returns turso only when DEFAULT_DB_HOST is turso", () => {
    using _env = withEnv({ DEFAULT_DB_HOST: "turso" });
    expect(getDefaultDbProvider()).toBe("turso");
  });

  test("returns bunny when DEFAULT_DB_HOST is missing", () => {
    using _env = withEnv({ DEFAULT_DB_HOST: undefined });
    expect(getDefaultDbProvider()).toBe("bunny");
  });

  test("returns bunny for any other configured value", () => {
    using _env = withEnv({ DEFAULT_DB_HOST: "some-unrecognised-host" });
    expect(getDefaultDbProvider()).toBe("bunny");
  });
});

describe("isBuilderEnabled", () => {
  test("reads CAN_BUILD_SITES as a switch with a safe default", () => {
    using _builder = withEnv({ CAN_BUILD_SITES: "true" });
    expect(isBuilderEnabled()).toBe(true);
    using _notBuilder = withEnv({ CAN_BUILD_SITES: "false" });
    expect(isBuilderEnabled()).toBe(false);
    using _unset = withEnv({ CAN_BUILD_SITES: undefined });
    expect(isBuilderEnabled()).toBe(false);
  });
});

expectEnabledByAllKeys("isTursoEnabled", isTursoEnabled, [
  "TURSO_API_TOKEN",
  "TURSO_ORGANIZATION",
  "TURSO_GROUP",
]);
expectRequiredEnvGetter(
  "getTursoApiToken",
  getTursoApiToken,
  "TURSO_API_TOKEN",
  "turso_token",
);
expectRequiredEnvGetter(
  "getTursoOrganization",
  getTursoOrganization,
  "TURSO_ORGANIZATION",
  "turso_org",
);
expectRequiredEnvGetter(
  "getTursoGroup",
  getTursoGroup,
  "TURSO_GROUP",
  "turso_group",
);
