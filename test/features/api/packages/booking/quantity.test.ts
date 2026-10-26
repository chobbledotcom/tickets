import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  apiBookPackage,
  describePackageBooking,
  fixedPackage,
} from "../helpers.ts";

describePackageBooking(() => {
  test("POST rejects an explicit quantity of 0 and malformed JSON", async () => {
    const { group } = await fixedPackage("Zero Kit", "zero-kit");
    const zero = await apiBookPackage(group.slug, { quantity: 0 });
    expect(zero.response.status).toBe(400);
    const bad = await apiBookPackage(group.slug, {}, "not json");
    expect(bad.response.status).toBe(400);
  });

  test("POST requires the quantity field", async () => {
    const { group } = await fixedPackage("Required Kit", "required-kit");
    // `quantity: undefined` drops the key from the helper's merged body.
    const { response, body } = await apiBookPackage(group.slug, {
      quantity: undefined,
    });
    // Package bundles state their count too: no default to one bundle.
    expect(response.status).toBe(400);
    expect(body.error).toBe("Quantity is required");
  });

  test("POST rejects a malformed quantity", async () => {
    const { group } = await fixedPackage("Default Kit", "default-kit");
    const { response, body } = await apiBookPackage(group.slug, {
      quantity: "lots",
    });
    expect(response.status).toBe(400);
    expect(body.error).toBe("Quantity must be a whole number of 1 or more");
  });
});
