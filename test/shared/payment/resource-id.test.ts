import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { isResourceId } from "#shared/payment/resource-id.ts";

describe("resource id", () => {
  it("accepts a non-empty id with text", () => {
    expect(isResourceId("pi_123")).toBe(true);
    expect(isResourceId("co_abc-001")).toBe(true);
  });

  // A paid session whose provider gave a blank or whitespace-only id must be
  // refused at the boundary; this is the guard that makes that refusal.
  it("refuses a blank or whitespace-only id", () => {
    expect(isResourceId("")).toBe(false);
    expect(isResourceId("   ")).toBe(false);
    expect(isResourceId("\t\n")).toBe(false);
  });

  // The id is sent back to the provider exactly as it arrived, so any broken
  // one would be booked as refundable and then match no charge at all —
  // failing every refund attempt and leaving the webhook retrying for good.
  it("refuses an id with whitespace anywhere in it", () => {
    expect(isResourceId(" pi_123")).toBe(false);
    expect(isResourceId("pi_123 ")).toBe(false);
    expect(isResourceId(" pi_123 ")).toBe(false);
    expect(isResourceId("\tpi_123\n")).toBe(false);
    expect(isResourceId("pi 123")).toBe(false);
    expect(isResourceId("pi\t123")).toBe(false);
  });

  it("keeps a single-character id", () => {
    expect(isResourceId("r")).toBe(true);
  });
});
