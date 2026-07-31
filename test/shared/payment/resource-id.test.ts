import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import * as v from "valibot";
import { isResourceId, ResourceIdSchema } from "#shared/payment/resource-id.ts";

describe("resource id", () => {
  describe("isResourceId", () => {
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
  });

  describe("ResourceIdSchema", () => {
    it("narrow types a real id but not a blank one", () => {
      expect(v.is(ResourceIdSchema, "pi_123")).toBe(true);
      expect(v.is(ResourceIdSchema, "")).toBe(false);
    });
  });
});
