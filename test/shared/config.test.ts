import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { ALL_SETTINGS_KEYS, settings } from "#db/settings.ts";
import {
  denoDeployAppSlug,
  getBookingFee,
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
  getEffectiveDomain,
  getEmbedHosts,
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
  isPaymentsEnabled,
  isSecureMode,
  isTursoEnabled,
  loadEffectiveDomain,
  resetEffectiveDomain,
  seedEffectiveDomainHost,
  setEffectiveDomainForTest,
  tursoDatabaseSlug,
} from "#shared/config.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupStripe } from "#test-utils/settings.ts";

describeWithEnv("isPaymentsEnabled", { db: true }, () => {
  test("returns false when no provider is configured", () => {
    expect(isPaymentsEnabled()).toBe(false);
  });

  test("returns false when provider is stripe but no secret key is set", async () => {
    await settings.update.paymentProvider("stripe");
    expect(isPaymentsEnabled()).toBe(false);
  });

  test("returns false when a stripe key is stored but no provider is selected", async () => {
    await settings.update.stripe.secretKey("sk_test_123");
    expect(isPaymentsEnabled()).toBe(false);
  });

  test("returns true when provider is stripe and a key is set", async () => {
    await setupStripe("sk_test_123");
    expect(isPaymentsEnabled()).toBe(true);
  });

  test("returns false when provider is square but no access token is set", async () => {
    await settings.update.paymentProvider("square");
    expect(isPaymentsEnabled()).toBe(false);
  });

  test("returns true when provider is square and a token is set", async () => {
    await settings.update.paymentProvider("square");
    await settings.update.square.accessToken("EAAAl_test_123");
    expect(isPaymentsEnabled()).toBe(true);
  });

  test("returns false when provider is sumup but no API key is set", async () => {
    await settings.update.paymentProvider("sumup");
    expect(isPaymentsEnabled()).toBe(false);
  });

  test("returns true when provider is sumup and an API key is set", async () => {
    await settings.update.paymentProvider("sumup");
    await settings.update.sumup.apiKey("sk_test_123");
    expect(isPaymentsEnabled()).toBe(true);
  });

  test("returns false when the raw provider value is not stripe or square", async () => {
    // setRaw bypasses the typed API; reload the snapshot so the getter sees it
    await settings.setRaw("payment_provider", "paypal");
    await settings.update.stripe.secretKey("sk_test_123");
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);
    expect(isPaymentsEnabled()).toBe(false);
  });
});

describeWithEnv("getBookingFee", { db: true }, () => {
  test("returns 0 when no booking fee is configured", () => {
    expect(getBookingFee()).toBe(0);
  });

  test("returns the parsed numeric value when configured", async () => {
    await settings.update.bookingFee("1.5");
    expect(getBookingFee()).toBe(1.5);
  });

  test("returns 0 when the stored value cannot be parsed as a number", async () => {
    await settings.update.bookingFee("abc");
    expect(getBookingFee()).toBe(0);
  });
});

describeWithEnv("getEffectiveDomain", { db: true }, () => {
  beforeEach(() => {
    resetEffectiveDomain();
  });
  afterEach(() => {
    resetEffectiveDomain();
  });

  test("returns 'localhost' before loadEffectiveDomain has been called", () => {
    expect(getEffectiveDomain()).toBe("localhost");
  });

  test("seedEffectiveDomainHost sets the request hostname before settings load", () => {
    seedEffectiveDomainHost(new URL("https://listing.example.com/ticket/abc"));
    expect(getEffectiveDomain()).toBe("listing.example.com");
  });

  test("loadEffectiveDomain refines the seeded host with the validated custom domain", async () => {
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    seedEffectiveDomainHost(new URL("https://mysite.bunny.run/"));
    expect(getEffectiveDomain()).toBe("mysite.bunny.run");

    loadEffectiveDomain(new URL("https://mysite.bunny.run/"));
    expect(getEffectiveDomain()).toBe("tickets.example.com");
  });

  test("loadEffectiveDomain falls back to the request hostname when nothing is configured", () => {
    const result = loadEffectiveDomain(new URL("https://mysite.bunny.run/"));
    expect(result).toBe("mysite.bunny.run");
    expect(getEffectiveDomain()).toBe("mysite.bunny.run");
  });

  test("returns the custom domain when it is set AND validated in the DB", async () => {
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    expect(loadEffectiveDomain(new URL("https://mysite.bunny.run/"))).toBe(
      "tickets.example.com",
    );
  });

  test("falls back to request hostname when custom domain is set but unvalidated", async () => {
    await settings.update.customDomain("tickets.example.com");
    expect(loadEffectiveDomain(new URL("https://mysite.bunny.run/"))).toBe(
      "mysite.bunny.run",
    );
  });

  test("reflects clearing the custom domain after it was previously validated", async () => {
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    loadEffectiveDomain(new URL("https://mysite.bunny.run/"));
    expect(getEffectiveDomain()).toBe("tickets.example.com");

    await settings.update.customDomain("");
    expect(loadEffectiveDomain(new URL("https://mysite.bunny.run/"))).toBe(
      "mysite.bunny.run",
    );
  });

  test("uses the bunny subdomain when it is set and no custom domain is configured", async () => {
    await settings.update.bunnySubdomain("mylisting.tickets.example.com");
    expect(loadEffectiveDomain(new URL("https://mysite.bunny.run/"))).toBe(
      "mylisting.tickets.example.com",
    );
  });

  test("validated custom domain takes priority over bunny subdomain", async () => {
    await settings.update.bunnySubdomain("mylisting.tickets.example.com");
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    expect(loadEffectiveDomain(new URL("https://mysite.bunny.run/"))).toBe(
      "tickets.example.com",
    );
  });

  test("bunny subdomain is used when custom domain is set but not validated", async () => {
    await settings.update.bunnySubdomain("mylisting.tickets.example.com");
    await settings.update.customDomain("tickets.example.com");
    expect(loadEffectiveDomain(new URL("https://mysite.bunny.run/"))).toBe(
      "mylisting.tickets.example.com",
    );
  });

  test("setEffectiveDomainForTest overrides the cached value", () => {
    setEffectiveDomainForTest("custom.example.com");
    expect(getEffectiveDomain()).toBe("custom.example.com");
  });

  test("resetEffectiveDomain clears the cached value back to 'localhost'", async () => {
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    loadEffectiveDomain(new URL("https://mysite.bunny.run/"));
    expect(getEffectiveDomain()).toBe("tickets.example.com");

    resetEffectiveDomain();
    expect(getEffectiveDomain()).toBe("localhost");
  });
});

describeWithEnv("getEmbedHosts", { db: true }, () => {
  test("returns an empty array when no embed hosts are configured", async () => {
    expect(await getEmbedHosts()).toEqual([]);
  });

  test("returns an empty array when the stored value is whitespace only", async () => {
    await settings.update.embedHosts("   ");
    expect(await getEmbedHosts()).toEqual([]);
  });

  test("parses a comma-separated list into normalized hostnames", async () => {
    await settings.update.embedHosts("Example.COM, *.mysite.org");
    expect(await getEmbedHosts()).toEqual(["example.com", "*.mysite.org"]);
  });

  test("reflects updates made after the first read", async () => {
    await settings.update.embedHosts("one.example.com");
    expect(await getEmbedHosts()).toEqual(["one.example.com"]);

    await settings.update.embedHosts("two.example.com, three.example.com");
    expect(await getEmbedHosts()).toEqual([
      "two.example.com",
      "three.example.com",
    ]);
  });
});

describe("secure mode by request host", () => {
  afterEach(resetEffectiveDomain);

  const secureModeWhenHostedAt = (hostname: string): boolean => {
    seedEffectiveDomainHost(new URL(`http://${hostname}:3000/`));
    return isSecureMode();
  };

  test("a real resolved host turns secure mode on", () => {
    expect(secureModeWhenHostedAt("tickets.example.com")).toBe(true);
  });

  test("the default domain, a localhost subdomain, and the IPv6 loopbacks stay off", () => {
    expect(secureModeWhenHostedAt("localhost")).toBe(false);
    expect(secureModeWhenHostedAt("shop.localhost")).toBe(false);
    expect(secureModeWhenHostedAt("[::1]")).toBe(false);
    setEffectiveDomainForTest("::1");
    expect(isSecureMode()).toBe(false);
  });

  test("an IPv4 loopback address stays off across the octet range", () => {
    expect(secureModeWhenHostedAt("127.0.0.1")).toBe(false);
    expect(secureModeWhenHostedAt("127.12.34.0")).toBe(false);
    expect(secureModeWhenHostedAt("127.255.255.255")).toBe(false);
  });

  test("an address that only looks like an IPv4 loopback keeps secure mode on", () => {
    // A different first octet is a real host.
    expect(secureModeWhenHostedAt("128.0.0.1")).toBe(true);
    // The forged shapes below are not URL-parseable, so seed them directly:
    // the wrong number of parts is a hostname, not an address.
    for (const host of [
      "127.0.1",
      "127.0.0.1.5",
      "127.0.0.256",
      "127.0.1e2.1",
    ]) {
      setEffectiveDomainForTest(host);
      expect(isSecureMode(), host).toBe(true);
    }
  });
});

describe("environment gates and secrets", () => {
  const GATES: [label: string, gate: () => boolean, vars: string[]][] = [
    ["bunny cdn", isBunnyCdnEnabled, ["BUNNY_API_KEY", "BUNNY_SCRIPT_ID"]],
    ["bunny dns", isBunnyDnsEnabled, ["BUNNY_API_KEY", "BUNNY_DNS_ZONE_ID"]],
    ["bunny db", isBunnyDbEnabled, ["BUNNY_API_KEY"]],
    [
      "botpoison",
      isBotpoisonEnabled,
      ["BOTPOISON_PUBLIC_KEY", "BOTPOISON_SECRET_KEY"],
    ],
    ["the instance api", isInstanceApiEnabled, ["MAIN_INSTANCE_KEY"]],
    [
      "deno deploy hosting",
      isDenoDeployEnabled,
      ["DENO_DEPLOY_TOKEN", "DENO_DEPLOY_ORG_ID", "DENO_DEPLOY_ORG_SLUG"],
    ],
    [
      "turso hosting",
      isTursoEnabled,
      ["TURSO_API_TOKEN", "TURSO_ORGANIZATION", "TURSO_GROUP"],
    ],
  ];

  for (const [label, gate, vars] of GATES) {
    test(`the ${label} gate reads every one of its variables`, () => {
      const filled = Object.fromEntries(vars.map((name) => [name, "set"]));
      using _present = withEnv(filled);
      expect(gate()).toBe(true);
      for (const missing of vars) {
        using _absent = withEnv({ ...filled, [missing]: undefined });
        expect(gate(), `${missing} alone`).toBe(false);
      }
    });
  }

  test("a required secret reads its own variable", () => {
    using _secrets = withEnv({
      BUNNY_API_KEY: "bunny-key",
      BUNNY_DNS_ZONE_ID: "zone-7",
      BUNNY_SCRIPT_ID: "script-9",
      DENO_DEPLOY_ORG_ID: "org-id",
      DENO_DEPLOY_ORG_SLUG: "org-slug",
      DENO_DEPLOY_TOKEN: "deno-token",
      MAIN_INSTANCE_KEY: "instance-key",
      TURSO_API_TOKEN: "turso-token",
      TURSO_GROUP: "turso-group",
      TURSO_ORGANIZATION: "turso-org",
    });
    expect(getBunnyApiKey()).toBe("bunny-key");
    expect(getBunnyDnsZoneId()).toBe("zone-7");
    expect(getBunnyScriptId()).toBe("script-9");
    expect(getDenoDeployToken()).toBe("deno-token");
    expect(getDenoDeployOrgId()).toBe("org-id");
    expect(getDenoDeployOrgSlug()).toBe("org-slug");
    expect(getMainInstanceKey()).toBe("instance-key");
    expect(getTursoApiToken()).toBe("turso-token");
    expect(getTursoOrganization()).toBe("turso-org");
    expect(getTursoGroup()).toBe("turso-group");
  });

  test("an optional value reads its variable or the empty string", () => {
    using _set = withEnv({
      BOTPOISON_PUBLIC_KEY: "public-key",
      BOTPOISON_SECRET_KEY: "secret-key",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
      DEBUG_KEY: "debug-key",
    });
    expect(getBunnyDnsSubdomainSuffix()).toBe(".tickets");
    expect(getDebugKey()).toBe("debug-key");
    expect(getBotpoisonPublicKey()).toBe("public-key");
    expect(getBotpoisonSecretKey()).toBe("secret-key");

    using _unset = withEnv({
      BOTPOISON_PUBLIC_KEY: undefined,
      BOTPOISON_SECRET_KEY: undefined,
      BUNNY_DNS_SUBDOMAIN_SUFFIX: undefined,
      DEBUG_KEY: undefined,
    });
    expect(getBunnyDnsSubdomainSuffix()).toBe("");
    expect(getDebugKey()).toBe("");
    expect(getBotpoisonPublicKey()).toBe("");
    expect(getBotpoisonSecretKey()).toBe("");
  });

  test("builder mode and the default database provider read their switches", () => {
    using _builder = withEnv({ CAN_BUILD_SITES: "true" });
    expect(isBuilderEnabled()).toBe(true);
    using _notBuilder = withEnv({ CAN_BUILD_SITES: "false" });
    expect(isBuilderEnabled()).toBe(false);

    using _turso = withEnv({ DEFAULT_DB_HOST: "turso" });
    expect(getDefaultDbProvider()).toBe("turso");
    using _unsetSwitches = withEnv({
      CAN_BUILD_SITES: undefined,
      DEFAULT_DB_HOST: undefined,
    });
    expect(isBuilderEnabled()).toBe(false);
    expect(getDefaultDbProvider()).toBe("bunny");
  });
});

describe("provider resource slugs", () => {
  test("a deno deploy app slug lowercases and replaces special chars with hyphens", () => {
    expect(denoDeployAppSlug("My Site Name")).toBe("my-site-name");
    expect(denoDeployAppSlug("Hello_World!")).toBe("hello-world");
  });

  test("a deno deploy app slug collapses consecutive hyphens", () => {
    expect(denoDeployAppSlug("a  b  c")).toBe("a-b-c");
  });

  test("a deno deploy app slug strips leading and trailing hyphens", () => {
    expect(denoDeployAppSlug("--leading")).toBe("leading");
    expect(denoDeployAppSlug("trailing--")).toBe("trailing");
  });

  test("a deno deploy app slug truncates to 32 chars", () => {
    expect(denoDeployAppSlug("a".repeat(40)).length).toBeLessThanOrEqual(32);
  });

  test("a deno deploy app slug ends clean when truncation lands on a separator", () => {
    const slug = denoDeployAppSlug("Tickets - 12345678901234567890123 A");
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test("a deno deploy app slug pads short slugs to at least 3 chars", () => {
    expect(denoDeployAppSlug("ab")).toBe("abapp");
    expect(denoDeployAppSlug("a")).toBe("aapp");
  });

  test("a turso database slug lowercases and replaces non-slug chars", () => {
    expect(tursoDatabaseSlug("My Site")).toBe("my-site");
    expect(tursoDatabaseSlug("Test_DB 123")).toBe("test-db-123");
  });

  test("a turso database slug collapses consecutive hyphens and trims", () => {
    expect(tursoDatabaseSlug("--My--Site--")).toBe("my-site");
  });

  test("a turso database slug truncates to 63 characters", () => {
    expect(tursoDatabaseSlug("a".repeat(100))).toBe("a".repeat(63));
  });

  test("a turso database slug ends clean when truncation lands on a separator", () => {
    const slug = tursoDatabaseSlug(`${"a".repeat(62)}-b`);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(63);
  });

  test("a turso database slug falls back to db for names that reduce to empty", () => {
    expect(tursoDatabaseSlug("---")).toBe("db");
  });
});
