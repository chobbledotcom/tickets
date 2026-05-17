import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { EventInput } from "#shared/db/events.ts";
import { validateEventInput } from "#shared/events-actions.ts";
import { setupTestEncryptionKey, testEventInput } from "#test-utils";

setupTestEncryptionKey();

describe("validateEventInput", () => {
  test("rejects assignBuiltSite with initialSiteMonths <= 0", async () => {
    const input: EventInput = {
      ...testEventInput({
        assignBuiltSite: true,
        hidden: true,
        initialSiteMonths: 0,
        monthsPerUnit: 1,
        purchaseOnly: true,
      }),
      slug: "test-event",
      slugIndex: "test-index",
    };
    const error = await validateEventInput(input);
    expect(error).toBe(
      "Initial site months is required when a site is assigned.",
    );
  });

  test("accepts assignBuiltSite when initial site months is positive", async () => {
    const input: EventInput = {
      ...testEventInput({
        assignBuiltSite: true,
        hidden: true,
        initialSiteMonths: 1,
        monthsPerUnit: 1,
        purchaseOnly: true,
      }),
      slug: "test-event",
      slugIndex: "test-index",
    };
    await expect(validateEventInput(input)).resolves.toBeNull();
  });
});
