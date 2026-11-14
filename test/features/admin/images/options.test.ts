import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { adminGet, makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withStorageDisabled } from "#test-utils/mocks.ts";

describeWithEnv(
  "GET /admin/images/options",
  { db: true, storage: "cdn" },
  () => {
    test("serves every image's id and name in name order", async () => {
      const zebra = await makeImage("Zebra");
      const alpha = await makeImage("alpha");

      const response = await adminGet("/admin/images/options");

      expect(response.status).toBe(200);
      const contentType = response.headers.get("content-type");
      assert(contentType !== null);
      assertStringIncludes(contentType, "application/json");
      expect(await response.json()).toEqual({
        images: [
          { id: alpha.id, name: "alpha" },
          { id: zebra.id, name: "Zebra" },
        ],
      });
    });

    test("serves an empty list when image storage is disabled", async () => {
      await makeImage("Hero");

      await withStorageDisabled(async () => {
        const response = await adminGet("/admin/images/options");

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ images: [] });
      });
    });
  },
);
