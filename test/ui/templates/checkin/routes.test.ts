import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("check-in route matching", { db: true }, () => {
  describe("route matching", () => {
    test("returns null for non-matching paths", async () => {
      const { routeCheckin } = await import("#routes/checkin.ts");
      const request = new Request("http://localhost/other");
      const result = await routeCheckin(request, "/other", "GET");
      expect(result).toBeNull();
    });

    test("returns null for unsupported methods", async () => {
      const { routeCheckin } = await import("#routes/checkin.ts");
      const request = new Request("http://localhost/checkin/tok", {
        method: "PUT",
      });
      const result = await routeCheckin(request, "/checkin/tok", "PUT");
      expect(result).toBeNull();
    });
  });
});
