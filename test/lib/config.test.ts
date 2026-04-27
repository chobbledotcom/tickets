import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import {
  getBookingFee,
  getEffectiveDomain,
  getEmbedHosts,
  isPaymentsEnabled,
  loadEffectiveDomain,
  resetEffectiveDomain,
  setEffectiveDomainForTest,
} from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv, setupStripe } from "#test-utils";

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

  test("returns false when the raw provider value is not stripe or square", async () => {
    // setRaw bypasses the typed API; reload the snapshot so the getter sees it
    await settings.setRaw("payment_provider", "paypal");
    await settings.update.stripe.secretKey("sk_test_123");
    settings.invalidateCache();
    await settings.loadAll();
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

  test("loadEffectiveDomain falls back to the request hostname when nothing is configured", () => {
    const result = loadEffectiveDomain("https://mysite.bunny.run/");
    expect(result).toBe("mysite.bunny.run");
    expect(getEffectiveDomain()).toBe("mysite.bunny.run");
  });

  test("returns the custom domain when it is set AND validated in the DB", async () => {
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    expect(loadEffectiveDomain("https://mysite.bunny.run/")).toBe(
      "tickets.example.com",
    );
  });

  test("falls back to request hostname when custom domain is set but unvalidated", async () => {
    await settings.update.customDomain("tickets.example.com");
    expect(loadEffectiveDomain("https://mysite.bunny.run/")).toBe(
      "mysite.bunny.run",
    );
  });

  test("reflects clearing the custom domain after it was previously validated", async () => {
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    loadEffectiveDomain("https://mysite.bunny.run/");
    expect(getEffectiveDomain()).toBe("tickets.example.com");

    await settings.update.customDomain("");
    expect(loadEffectiveDomain("https://mysite.bunny.run/")).toBe(
      "mysite.bunny.run",
    );
  });

  test("uses the bunny subdomain when it is set and no custom domain is configured", async () => {
    await settings.update.bunnySubdomain("myevent.tickets.example.com");
    expect(loadEffectiveDomain("https://mysite.bunny.run/")).toBe(
      "myevent.tickets.example.com",
    );
  });

  test("validated custom domain takes priority over bunny subdomain", async () => {
    await settings.update.bunnySubdomain("myevent.tickets.example.com");
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    expect(loadEffectiveDomain("https://mysite.bunny.run/")).toBe(
      "tickets.example.com",
    );
  });

  test("bunny subdomain is used when custom domain is set but not validated", async () => {
    await settings.update.bunnySubdomain("myevent.tickets.example.com");
    await settings.update.customDomain("tickets.example.com");
    expect(loadEffectiveDomain("https://mysite.bunny.run/")).toBe(
      "myevent.tickets.example.com",
    );
  });

  test("setEffectiveDomainForTest overrides the cached value", () => {
    setEffectiveDomainForTest("custom.example.com");
    expect(getEffectiveDomain()).toBe("custom.example.com");
  });

  test("resetEffectiveDomain clears the cached value back to 'localhost'", async () => {
    await settings.update.customDomain("tickets.example.com");
    await settings.update.customDomainLastValidated();
    loadEffectiveDomain("https://mysite.bunny.run/");
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
