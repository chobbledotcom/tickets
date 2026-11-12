/**
 * The external sources admin API: the source CRUD and the feature gate that
 * turns every directory route off.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { requireOne } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  addListing,
  createLink,
  createSource,
  linksPath,
  SOURCE_BODY,
  sourcePath,
} from "#test-utils/external-sources.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { apiRequest } from "#test-utils/session.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";

describeWithEnv("Admin API - External sources", { db: true }, () => {
  useSetting(featureSetting("externalSources"));

  describe("the feature gate", () => {
    test("answers 403 while the feature is off", async () => {
      settings.setForTest(featureSetting());

      await assertJson(
        apiRequest("/api/admin/external-sources"),
        403,
        (body) => {
          expect(body.error).toBe(
            "The external sources feature is disabled. Turn it on in Settings, then try again.",
          );
        },
      );
    });

    test("answers 401 without auth", async () => {
      const response = await handleRequest(
        mockRequest("/api/admin/external-sources"),
      );
      expect(response.status).toBe(401);
    });
  });

  describe("GET /api/admin/external-sources", () => {
    test("lists every source with its URL pattern", async () => {
      await createSource();
      await createSource({
        name: "Shipping labels",
        url_pattern: "https://carrier.example/{external_id}",
      });

      await assertJson(
        apiRequest("/api/admin/external-sources"),
        200,
        (body) => {
          expect(
            body["external-sources"].map(
              (source: { name: string }) => source.name,
            ),
          ).toEqual(["Stripe invoices", "Shipping labels"]);
          expect(body["external-sources"][0].url_pattern).toBe(
            SOURCE_BODY.url_pattern,
          );
        },
      );
    });
  });

  describe("GET /api/admin/external-sources/:sourceId", () => {
    test("returns one source with its stored created stamp", async () => {
      const created = await createSource();

      await assertJson(
        apiRequest(sourcePath(Number(created.source.id))),
        200,
        (body) => {
          expect(body.source).toEqual(created.source);
          expect(body.source.created).toMatch(/Z$/);
        },
      );
    });

    test("returns 404 for a source that does not exist", async () => {
      await assertJson(apiRequest(sourcePath(999_999)), 404, (body) => {
        expect(body.error).toBe("Source not found");
      });
    });
  });

  describe("POST /api/admin/external-sources", () => {
    test("refuses a source with no URL pattern", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources", {
          body: { name: "Invoices" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("url_pattern is required");
        },
      );
    });

    test("refuses a blank name", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources", {
          body: {
            name: "  ",
            url_pattern: "https://example.com/{external_id}",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name is required");
        },
      );
    });

    test("refuses a name longer than a short input", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources", {
          body: {
            name: "n".repeat(251),
            url_pattern: "https://example.com/{external_id}",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name must be 250 characters or fewer");
        },
      );
    });

    test("refuses a URL pattern that is not a string", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources", {
          body: { name: "Invoices", url_pattern: 7 },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("url_pattern must be a string");
        },
      );
    });

    test("refuses a URL pattern that is not a web address", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources", {
          body: {
            name: "Invoices",
            url_pattern: "dashboard.stripe.com/{external_id}",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "url_pattern must start with http:// or https://",
          );
        },
      );
    });

    test("refuses a URL pattern with a placeholder it cannot fill", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources", {
          body: {
            name: "Diary",
            url_pattern: "https://diary.example/events/{event_id}",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("url_pattern can fill only {external_id}");
        },
      );
    });

    test("refuses a URL pattern that holds a placeholder twice", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources", {
          body: {
            name: "Diary",
            url_pattern:
              "https://diary.example/{external_id}/copy/{external_id}",
          },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe(
            "url_pattern must hold each placeholder once",
          );
        },
      );
    });

    test("stores a destination address that needs no external id", async () => {
      await assertJson(
        apiRequest("/api/admin/external-sources", {
          body: {
            name: "Diary",
            url_pattern: "https://diary.example/new-booking",
          },
          method: "POST",
        }),
        201,
        (body) => {
          expect(body.source.url_pattern).toBe(
            "https://diary.example/new-booking",
          );
        },
      );
    });
  });

  describe("PUT /api/admin/external-sources/:sourceId", () => {
    test("changes one field and keeps the other", async () => {
      const created = await createSource();

      await assertJson(
        apiRequest(sourcePath(Number(created.source.id)), {
          body: { url_pattern: "https://billing.example/{external_id}" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.source.name).toBe(SOURCE_BODY.name);
          expect(body.source.url_pattern).toBe(
            "https://billing.example/{external_id}",
          );
        },
      );
    });

    test("refuses a blank field on an update", async () => {
      const cases = [
        { body: { name: "  " }, error: "name cannot be empty" },
        {
          body: { url_pattern: "  " },
          error: "url_pattern cannot be empty",
        },
      ];
      for (const { body, error } of cases) {
        const created = await createSource();
        await assertJson(
          apiRequest(sourcePath(Number(created.source.id)), {
            body,
            method: "PUT",
          }),
          400,
          (refused) => {
            expect(refused.error).toBe(error);
          },
        );
      }
    });
  });

  describe("DELETE /api/admin/external-sources/:sourceId", () => {
    test("needs the exact stored name", async () => {
      const created = await createSource();

      await assertJson(
        apiRequest(sourcePath(Number(created.source.id)), {
          body: { confirm_identifier: "Stripe invoices and payments" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toContain("Source name does not match");
        },
      );
    });

    test("deletes the source and its links", async () => {
      const created = await createSource();
      const sourceId = Number(created.source.id);
      const listing = await addListing();
      await createLink(sourceId, {
        external_id: "INV-1",
        link_id: listing.id,
        link_type: "listing",
      });

      await assertJson(
        apiRequest(sourcePath(sourceId), {
          body: { confirm_identifier: SOURCE_BODY.name },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body).toEqual({ status: "ok" });
        },
      );
      await assertJson(apiRequest(sourcePath(sourceId)), 404);
      const links = await requireOne<{ total: number }>(
        "SELECT COUNT(*) AS total FROM external_source_links WHERE source_id = ?",
        [sourceId],
      );
      expect(links.total).toBe(0);
    });
  });

  describe("the link routes", () => {
    test("answer 404 when the source does not exist", async () => {
      await assertJson(
        apiRequest(linksPath(999_999), {
          body: {
            external_id: "INV-1",
            link_id: 7,
            link_type: "listing",
          },
          method: "POST",
        }),
        404,
        (body) => {
          expect(body.error).toBe("Source not found");
        },
      );
    });
  });
});
