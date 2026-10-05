import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { listingAttributeOptions } from "#db/attributes.ts";
import { handleRequest } from "#routes";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttribute,
  createTestAttributeOption,
} from "#test-utils/db-helpers/attributes.ts";
import {
  apiRequest,
  createTestManagerSession,
  requestAsSession,
  testCookie,
  testCsrfToken,
} from "#test-utils/session.ts";

describeWithEnv("Admin API - Listings", { db: true }, () => {
  describe("attribute_option_ids on listing writes", () => {
    test("creates a listing with its attribute selection", async () => {
      const attribute = await createTestAttribute("Player Count");
      const option = await createTestAttributeOption(
        attribute.id,
        "1-4 players",
        0,
      );

      const body = await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            attribute_option_ids: [option.id],
            max_attendees: 1,
            name: "Selected",
          },
          method: "POST",
        }),
        201,
      );
      expect(body.listing.attribute_option_ids).toEqual([option.id]);
      expect(await listingAttributeOptions.getIds(body.listing.id)).toEqual([
        option.id,
      ]);
    });

    test("rejects an unknown option id instead of storing a smaller selection", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            attribute_option_ids: [424242],
            max_attendees: 1,
            name: "Stale Option",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "attribute_option_ids must name existing options",
          );
        },
      );
    });

    test("rejects non-integer entries like group_ids", async () => {
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            attribute_option_ids: ["3"],
            max_attendees: 1,
            name: "Bad Entry",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "attribute_option_ids must contain only positive integer ids",
          );
        },
      );
    });

    test("replaces the selection on update and keeps it when absent", async () => {
      const attribute = await createTestAttribute("Game Length");
      const first = await createTestAttributeOption(
        attribute.id,
        "15-20 minutes",
        0,
      );
      const second = await createTestAttributeOption(
        attribute.id,
        "20-30 minutes",
        1,
      );
      const created = await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            attribute_option_ids: [first.id],
            max_attendees: 1,
            name: "Timed",
          },
          method: "POST",
        }),
        201,
      );
      const listingId = created.listing.id as number;

      const replaced = await assertJson(
        apiRequest(`/api/admin/listings/${listingId}`, {
          body: { attribute_option_ids: [second.id] },
          method: "PUT",
        }),
        200,
      );
      expect(replaced.listing.attribute_option_ids).toEqual([second.id]);

      const kept = await assertJson(
        apiRequest(`/api/admin/listings/${listingId}`, {
          body: { description: "Unrelated edit" },
          method: "PUT",
        }),
        200,
      );
      expect(kept.listing.attribute_option_ids).toEqual([second.id]);

      await assertJson(
        apiRequest(`/api/admin/listings/${listingId}`, {
          body: { attribute_option_ids: [] },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.listing.attribute_option_ids).toEqual([]);
        },
      );
      expect(await listingAttributeOptions.getIds(listingId)).toEqual([]);
    });

    test("accepts options created moments earlier without a replica read", async () => {
      // The importer creates options and immediately creates a listing that
      // selects them. The existence check shares the link write's transaction
      // (the primary), so the fresh ids pass with no replica read to lag.
      const attribute = await createTestAttribute("Power Required");
      const option = await createTestAttributeOption(
        attribute.id,
        "Mains power required",
        0,
      );
      await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            attribute_option_ids: [option.id],
            max_attendees: 1,
            name: "Fresh Option",
          },
          method: "POST",
        }),
        201,
      );
    });

    test("refuses a manager's write that carries attribute_option_ids", async () => {
      // Attribute assignment is owner-only in the dashboard, so a manager (or
      // any non-owner) cannot set it through the listing routes either.
      const attribute = await createTestAttribute("Game Length");
      const option = await createTestAttributeOption(
        attribute.id,
        "15-20 minutes",
        0,
      );
      const response = await handleRequest(
        requestAsSession(
          "/api/admin/listings",
          {
            cookie: await createTestManagerSession(),
            csrfToken: await testCsrfToken(),
          },
          {
            body: JSON.stringify({
              attribute_option_ids: [option.id],
              max_attendees: 1,
              name: "Manager Write",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("attribute_option_ids is owner-only");
    });

    test("accepts an owner's write that carries attribute_option_ids", async () => {
      const attribute = await createTestAttribute("Game Length");
      const option = await createTestAttributeOption(
        attribute.id,
        "20-30 minutes",
        0,
      );
      const response = await handleRequest(
        requestAsSession(
          "/api/admin/listings",
          {
            cookie: await testCookie(),
            csrfToken: await testCsrfToken(),
          },
          {
            body: JSON.stringify({
              attribute_option_ids: [option.id],
              max_attendees: 1,
              name: "Owner Write",
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        ),
      );
      expect(response.status).toBe(201);
    });

    test("an update that omits the field never reads the stored links", async () => {
      // The stored selection must not flow back through persistence on an
      // unrelated update: a lagging read would restore a stale selection.
      // Stub the link read to fail; the update must not touch it.
      const attribute = await createTestAttribute("Guest Capacity");
      const option = await createTestAttributeOption(
        attribute.id,
        "50-500 guests",
        0,
      );
      const created = await assertJson(
        apiRequest("/api/admin/listings", {
          body: {
            attribute_option_ids: [option.id],
            max_attendees: 1,
            name: "Stable",
          },
          method: "POST",
        }),
        201,
      );
      const listingId = created.listing.id as number;
      const linkRead = stub(listingAttributeOptions, "getIds", () =>
        Promise.reject(new Error("the update must not read the stored links")),
      );
      try {
        await assertJson(
          apiRequest(`/api/admin/listings/${listingId}`, {
            body: { description: "Unrelated edit" },
            method: "PUT",
          }),
          200,
        );
      } finally {
        linkRead.restore();
      }
      expect(await listingAttributeOptions.getIds(listingId)).toEqual([
        option.id,
      ]);
    });
  });
});
