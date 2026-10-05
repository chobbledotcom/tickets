import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  attributeReads,
  attributesTable,
  getAllAttributesWithOptions,
  listingAttributeOptions,
} from "#db/attributes.ts";
import { handleRequest } from "#routes";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  assertApiDeleteOk,
  assertJson,
  expectRejectsEmptyName,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttribute,
  createTestAttributeOption,
} from "#test-utils/db-helpers/attributes.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  apiRequest,
  createTestManagerSession,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

describeWithEnv("Admin API - Attributes", { db: true }, () => {
  describe("GET /api/admin/attributes", () => {
    test("lists attributes with their options", async () => {
      const attribute = await createTestAttribute("Guest Capacity");
      await createTestAttributeOption(attribute.id, "20-200 guests", 0);
      await createTestAttributeOption(attribute.id, "50-300 guests", 1);

      await assertJson(apiRequest("/api/admin/attributes"), 200, (body) => {
        expect(body.attributes.length).toBe(1);
        expect(body.attributes[0].name).toBe("Guest Capacity");
        expect(
          body.attributes[0].options.map((o: { text: string }) => o.text),
        ).toEqual(["20-200 guests", "50-300 guests"]);
      });
    });

    test("returns empty array when no attributes exist", async () => {
      await assertJson(apiRequest("/api/admin/attributes"), 200, (body) => {
        expect(body.attributes).toEqual([]);
      });
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(
        mockRequest("/api/admin/attributes"),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/attributes/:attributeId", () => {
    test("returns one attribute with its options", async () => {
      const attribute = await createTestAttribute("Player Count");
      const option = await createTestAttributeOption(
        attribute.id,
        "1-4 players",
        0,
      );

      await assertJson(
        apiRequest(`/api/admin/attributes/${attribute.id}`),
        200,
        (body) => {
          expect(body.attribute.name).toBe("Player Count");
          expect(body.attribute.options).toEqual([
            {
              attribute_id: attribute.id,
              id: option.id,
              sort_order: 0,
              text: "1-4 players",
            },
          ]);
        },
      );
    });

    test("returns 404 for a non-existent attribute", async () => {
      await assertJson(
        apiRequest("/api/admin/attributes/99999"),
        404,
        (body) => {
          expect(body.error).toBe("Attribute not found");
        },
      );
    });
  });

  describe("POST /api/admin/attributes", () => {
    test("creates an attribute with an empty option list", async () => {
      await assertJson(
        apiRequest("/api/admin/attributes", {
          body: { name: "Game Length" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.attribute.name).toBe("Game Length");
          expect(body.attribute.options).toEqual([]);
          expect(body.attribute.id).toBeGreaterThan(0);
        },
      );
      const all = await getAllAttributesWithOptions();
      expect(all.map((attribute) => attribute.name)).toEqual(["Game Length"]);
    });

    test("places each new attribute after the stored ones", async () => {
      const first = await assertJson(
        apiRequest("/api/admin/attributes", {
          body: { name: "First" },
          method: "POST",
        }),
        201,
      );
      const second = await assertJson(
        apiRequest("/api/admin/attributes", {
          body: { name: "Second" },
          method: "POST",
        }),
        201,
      );
      expect(second.attribute.sort_order).toBeGreaterThan(
        first.attribute.sort_order,
      );
    });

    test("returns error when name is missing", async () => {
      await assertJson(
        apiRequest("/api/admin/attributes", { body: {}, method: "POST" }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
      );
    });
  });

  describe("PUT /api/admin/attributes/:attributeId", () => {
    test("renames an attribute and keeps its options", async () => {
      const attribute = await createTestAttribute("Old Name");
      await createTestAttributeOption(attribute.id, "Kept", 0);

      await assertJson(
        apiRequest(`/api/admin/attributes/${attribute.id}`, {
          body: { name: "New Name" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.attribute.name).toBe("New Name");
          expect(
            body.attribute.options.map((o: { text: string }) => o.text),
          ).toEqual(["Kept"]);
        },
      );
    });

    test("returns 404 for a non-existent attribute", async () => {
      await assertJson(
        apiRequest("/api/admin/attributes/99999", {
          body: { name: "Nope" },
          method: "PUT",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Attribute not found");
        },
      );
    });

    test("rejects an empty name", async () => {
      const attribute = await createTestAttribute();
      await expectRejectsEmptyName(`/api/admin/attributes/${attribute.id}`);
    });

    test("reads a stored empty name as an update, not a create", async () => {
      // Only a write outside this API can store an empty name, but the update
      // path must still treat such a row as existing: an absent name falls back
      // to the stored value (and fails as "cannot be empty"), not to the
      // create path's "is required".
      const row = await attributesTable.insert({ name: "" });
      await assertJson(
        apiRequest(`/api/admin/attributes/${row.id}`, {
          body: {},
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name cannot be empty");
        },
      );
    });
  });

  describe("DELETE /api/admin/attributes/:attributeId", () => {
    test("deletes an attribute, its options, and the listing links", async () => {
      const attribute = await createTestAttribute("To Delete");
      const option = await createTestAttributeOption(attribute.id, "Used", 0);
      const listing = await createListingWithOption(option.id);

      await assertApiDeleteOk(
        `/api/admin/attributes/${attribute.id}`,
        "To Delete",
      );

      expect(await attributeReads.any(attribute.id)).toBeNull();
      expect(await listingAttributeOptions.getIds(listing.id)).toEqual([]);
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const attribute = await createTestAttribute("Protected");

      await assertJson(
        apiRequest(`/api/admin/attributes/${attribute.id}`, {
          body: { confirm_identifier: "Wrong Name" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toContain("does not match");
        },
      );
      expect(await attributeReads.any(attribute.id)).not.toBeNull();
    });

    test("returns 404 for a non-existent attribute", async () => {
      await assertJson(
        apiRequest("/api/admin/attributes/99999", {
          body: { confirm_identifier: "anything" },
          method: "DELETE",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Attribute not found");
        },
      );
    });
  });

  describe("POST /api/admin/attributes/:attributeId/options", () => {
    test("appends an option and returns the attribute with it", async () => {
      const attribute = await createTestAttribute("Game Length");
      await createTestAttributeOption(attribute.id, "15-20 minutes", 0);

      await assertJson(
        apiRequest(`/api/admin/attributes/${attribute.id}/options`, {
          body: { text: "20-30 minutes" },
          method: "POST",
        }),
        201,
        (body) => {
          expect(
            body.attribute.options.map((o: { text: string }) => o.text),
          ).toEqual(["15-20 minutes", "20-30 minutes"]);
        },
      );
      expect(await activityMessages()).toContain(
        "Attribute option '20-30 minutes' added to Game Length",
      );
    });

    test("creates an option when the replica read lags the attribute create", async () => {
      // The importer creates an attribute and immediately posts its first
      // option. The option routes load the attribute from the primary, so a
      // lagging replica must not 404 the row the create just made. Stub the
      // replica read to miss the attribute entirely.
      const attribute = await createTestAttribute("Guest Capacity");
      const replica = stub(attributeReads, "any", () => Promise.resolve(null));
      try {
        await assertJson(
          apiRequest(`/api/admin/attributes/${attribute.id}/options`, {
            body: { text: "20-200 guests" },
            method: "POST",
          }),
          201,
          (body) => {
            expect(
              body.attribute.options.map((o: { text: string }) => o.text),
            ).toContain("20-200 guests");
          },
        );
      } finally {
        replica.restore();
      }
    });

    test("returns error when text is missing", async () => {
      const attribute = await createTestAttribute("No Text");

      await assertJson(
        apiRequest(`/api/admin/attributes/${attribute.id}/options`, {
          body: {},
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("text is required");
        },
      );
    });

    test("returns 404 for a non-existent attribute", async () => {
      await assertJson(
        apiRequest("/api/admin/attributes/99999/options", {
          body: { text: "Nope" },
          method: "POST",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Attribute not found");
        },
      );
    });
  });

  describe("PUT /api/admin/attributes/:attributeId/options/:optionId", () => {
    test("renames an option", async () => {
      const attribute = await createTestAttribute("Player Count");
      const option = await createTestAttributeOption(
        attribute.id,
        "2 players",
        0,
      );

      await assertJson(
        apiRequest(
          `/api/admin/attributes/${attribute.id}/options/${option.id}`,
          { body: { text: "2-4 players" }, method: "PUT" },
        ),
        200,
        (body) => {
          expect(body.attribute.options).toEqual([
            {
              attribute_id: attribute.id,
              id: option.id,
              sort_order: 0,
              text: "2-4 players",
            },
          ]);
        },
      );
      expect(await activityMessages()).toContain(
        "Attribute option '2-4 players' updated in Player Count",
      );
    });

    test("returns 404 for an unknown attribute", async () => {
      await assertJson(
        apiRequest("/api/admin/attributes/99999/options/1", {
          body: { text: "Nope" },
          method: "PUT",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Attribute not found");
        },
      );
    });

    test("returns 404 for an option under another attribute", async () => {
      const attribute = await createTestAttribute("Owner");
      const other = await createTestAttribute("Other");
      const option = await createTestAttributeOption(other.id, "Stray", 0);

      await assertJson(
        apiRequest(
          `/api/admin/attributes/${attribute.id}/options/${option.id}`,
          { body: { text: "Hijack" }, method: "PUT" },
        ),
        404,
        (body) => {
          expect(body.error).toBe("Attribute option not found");
        },
      );
    });
  });

  describe("DELETE /api/admin/attributes/:attributeId/options/:optionId", () => {
    test("deletes an option with the right confirmation", async () => {
      const attribute = await createTestAttribute("Game Length");
      const option = await createTestAttributeOption(
        attribute.id,
        "5 minutes",
        0,
      );

      await assertApiDeleteOk(
        `/api/admin/attributes/${attribute.id}/options/${option.id}`,
        "5 minutes",
      );
      expect((await attributeReads.any(attribute.id))?.options).toEqual([]);
      expect(await activityMessages()).toContain(
        "Attribute option '5 minutes' deleted from Game Length",
      );
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const attribute = await createTestAttribute("Player Count");
      const option = await createTestAttributeOption(
        attribute.id,
        "1 player",
        0,
      );

      await assertJson(
        apiRequest(
          `/api/admin/attributes/${attribute.id}/options/${option.id}`,
          { body: { confirm_identifier: "wrong" }, method: "DELETE" },
        ),
        400,
        (body) => {
          expect(body.error).toBe(
            "confirm_identifier does not match the option text",
          );
        },
      );
      expect((await attributeReads.any(attribute.id))?.options.length).toBe(1);
    });
  });

  // Attribute management is owner-only in the dashboard, so the JSON API must
  // reject managers too (a cookie-authenticated manager would otherwise reach
  // owner-gated operations through the API).
  describe("owner-only authorization", () => {
    test("rejects a manager listing attributes with 403 Forbidden", async () => {
      const res = await handleRequest(
        requestAsSession("/api/admin/attributes", {
          cookie: await createTestManagerSession(),
          csrfToken: await testCsrfToken(),
        }),
      );
      expect(res.status).toBe(403);
    });

    test("accepts an owner cookie session", async () => {
      await assertJson(
        handleRequest(
          requestAsSession("/api/admin/attributes", {
            cookie: await testCookie(),
            csrfToken: await testCsrfToken(),
          }),
        ),
        200,
      );
    });
  });

  /** One listing linked to one attribute option, through the API's own write
   * path, so delete-cascade tests exercise the real link rows. */
  async function createListingWithOption(optionId: number) {
    const body = await assertJson(
      apiRequest("/api/admin/listings", {
        body: {
          attribute_option_ids: [optionId],
          max_attendees: 1,
          name: "Linked listing",
        },
        method: "POST",
      }),
      201,
    );
    return body.listing as { id: number };
  }
});
