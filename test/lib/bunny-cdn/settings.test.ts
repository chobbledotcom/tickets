import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("bunny-cdn domain settings", { db: true }, () => {
  test("customDomain defaults to empty string", () => {
    expect(settings.customDomain).toBe("");
  });

  test("customDomain stores and clears", async () => {
    await settings.update.customDomain("tickets.example.com");
    expect(settings.customDomain).toBe("tickets.example.com");
    await settings.update.customDomain("");
    expect(settings.customDomain).toBe("");
  });

  test("customDomainLastValidated defaults to empty string", () => {
    expect(settings.customDomainLastValidated).toBe("");
  });

  test("customDomainLastValidated stores an ISO timestamp", async () => {
    await settings.update.customDomainLastValidated();
    const value = settings.customDomainLastValidated;
    expect(value).not.toBeNull();
    expect(new Date(value!).toISOString()).toBe(value);
  });

  test("bunnySubdomain stores and clears", async () => {
    await settings.update.bunnySubdomain("mylisting.tickets.example.com");
    expect(settings.bunnySubdomain).toBe("mylisting.tickets.example.com");
    await settings.update.bunnySubdomain("");
    expect(settings.bunnySubdomain).toBe("");
  });
});
