import type { TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAttributeWithOptions } from "#db/attributes.ts";
import { getDb } from "#db/client.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { assertApiDeleteOk, assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttribute,
  createTestAttributeOption,
} from "#test-utils/db-helpers/attributes.ts";
import { withEnv } from "#test-utils/env.ts";
import { apiRequest } from "#test-utils/session.ts";

describeWithEnv("Admin API - Attribute options", { db: true }, () => {
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

    test("loads the attribute on the primary, so a lagging replica cannot 404 it", async () => {
      // The importer creates an attribute and immediately posts its first
      // option. The option routes load the attribute on the primary, which a
      // write-mode batch names — the same proof the capacity preflight uses.
      const attribute = await createTestAttribute("Guest Capacity");
      const realBatch = getDb().batch.bind(getDb());
      const calls: { mode: string; sqls: string[] }[] = [];
      using _env = withEnv({ DB_URL: "http://primary.example" });
      const batchStub = stub(
        getDb(),
        "batch",
        (statements: unknown, mode?: TransactionMode) => {
          calls.push({
            mode: mode ?? "",
            sqls: (statements as { sql: string }[]).map(({ sql }) => sql),
          });
          return realBatch(statements as never, mode);
        },
      );
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
        batchStub.restore();
      }
      // The gate's load and the response's read-your-writes re-read each run
      // as one write-mode batch over the joined attribute rows.
      const attributeReadsInRequest = calls.filter((call) =>
        call.sqls.some((sql) => sql.includes("FROM attributes AS attribute")),
      );
      expect(attributeReadsInRequest).toHaveLength(2);
      expect(attributeReadsInRequest.map((call) => call.mode)).toEqual([
        "write",
        "write",
      ]);
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
      expect((await getAttributeWithOptions(attribute.id))?.options).toEqual(
        [],
      );
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
            "Option text does not match. Please provide the exact option text in confirm_identifier.",
          );
        },
      );
      expect(
        (await getAttributeWithOptions(attribute.id))?.options.length,
      ).toBe(1);
    });
  });
});
