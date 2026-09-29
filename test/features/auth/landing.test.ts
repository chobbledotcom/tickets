import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { adminLandingPath } from "#routes/auth.ts";

describe("adminLandingPath", () => {
  // Each role lands where its work lives: agents run deliveries, editors manage
  // listings, scanner users pick a door, and staff (owner/manager) get the full
  // dashboard.
  test("sends an agent to the deliveries run sheet", () => {
    expect(adminLandingPath("agent")).toBe("/admin/deliveries");
  });
  test("sends an editor to the listings page", () => {
    expect(adminLandingPath("editor")).toBe("/admin/listings");
  });
  test("sends a scanner to the doors list", () => {
    expect(adminLandingPath("scanner")).toBe("/admin/scanner");
  });
  test("sends an owner to the dashboard root", () => {
    expect(adminLandingPath("owner")).toBe("/admin");
  });
  test("sends a manager to the dashboard root", () => {
    expect(adminLandingPath("manager")).toBe("/admin");
  });
});
