import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { expectStoredThenCleared } from "#test-utils/settings-accessors.ts";

describeWithEnv("bunny-cdn domain settings", { db: true }, () => {
  test("customDomain defaults to empty string", () => {
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

  /** The domain settings that store a host and clear back to empty. */
  const hostSettings = [
    {
      name: "customDomain stores and clears",
      read: () => settings.customDomain,
      update: settings.update.customDomain,
      value: "tickets.example.com",
    },
    {
      name: "bunnySubdomain stores and clears",
      read: () => settings.bunnySubdomain,
      update: settings.update.bunnySubdomain,
      value: "mylisting.tickets.example.com",
    },
  ];

  for (const { name, read, update, value } of hostSettings) {
    test(name, async () => {
      await expectStoredThenCleared({ read, update }, value, "");
    });
  }
});
