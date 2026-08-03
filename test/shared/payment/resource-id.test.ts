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

  // A padded id is stored and sent back to the provider exactly as it arrived,
  // so it would be booked as refundable and then match no charge at all.
  it("refuses an id with space around it", () => {
    expect(isResourceId(" pi_123")).toBe(false);
    expect(isResourceId("pi_123 ")).toBe(false);
    expect(isResourceId(" pi_123 ")).toBe(false);
    expect(isResourceId("\tpi_123\n")).toBe(false);
  });

  it("keeps a single character and inner spacing", () => {
    expect(isResourceId("r")).toBe(true);
    expect(isResourceId("pi 123")).toBe(true);
  });
});
