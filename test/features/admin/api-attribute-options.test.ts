import type { TransactionMode } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAttributeWithOptions } from "#db/attributes.ts";
import { getDb } from "#db/client.ts";
import {
  AdminApiError,
  adminApiChildCreate,
} from "#shared/admin-api-client.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiAttribute,
} from "#shared/admin-api-resources.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { adminApiTestTransport } from "#test-utils/admin-api-transport.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttribute,
  createTestAttributeOption,
} from "#test-utils/db-helpers/attributes.ts";
import { withEnv } from "#test-utils/env.ts";

const { attributes } = ADMIN_API_RESOURCES;

describeWithEnv("Admin API - Attribute options", { db: true }, () => {
  describe("POST /api/admin/attributes/:attributeId/options", () => {
    test("appends an option and returns the attribute with it", async () => {
      const attribute = await createTestAttribute("Game Length");
      await createTestAttributeOption(attribute.id, "15-20 minutes", 0);

      const answered = await adminApiChildCreate(
        adminApiTestTransport,
        attributes,
        "options",
        attribute.id,
        { text: "20-30 minutes" },
      );
      expect(answered.attribute.options.map((option) => option.text)).toEqual([
        "15-20 minutes",
        "20-30 minutes",
      ]);
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
        const answered = await adminApiChildCreate(
          adminApiTestTransport,
          attributes,
          "options",
          attribute.id,
          { text: "20-200 guests" },
        );
        expect(
          answered.attribute.options.map((option) => option.text),
        ).toContain("20-200 guests");
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

      const failure = await adminApiChildCreate(
        adminApiTestTransport,
        attributes,
        "options",
        attribute.id,
        {},
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AdminApiError);
      expect((failure as Error).message).toBe("text is required (status 400)");
    });

    test("returns 404 for a non-existent attribute", async () => {
      const failure = await adminApiChildCreate(
        adminApiTestTransport,
        attributes,
        "options",
        99999,
        { text: "Nope" },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AdminApiError);
      expect((failure as Error).message).toBe(
        "Attribute not found (status 404)",
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

      const answered = await adminApiTestTransport({
        body: { text: "2-4 players" },
        method: "PUT",
        path: `/api/admin/attributes/${attribute.id}/options/${option.id}`,
      });
      expect(answered.status).toBe(200);
      const renamed = (answered.data as { attribute: AdminApiAttribute })
        .attribute;
      expect(renamed.options).toEqual([
        {
          attribute_id: attribute.id,
          id: option.id,
          sort_order: 0,
          text: "2-4 players",
        },
      ]);
      expect(await activityMessages()).toContain(
        "Attribute option '2-4 players' updated in Player Count",
      );
    });

    test("returns 404 for an unknown attribute", async () => {
      const failure = await adminApiTestTransport({
        method: "PUT",
        path: "/api/admin/attributes/99999/options/1",
      });
      expect(failure.status).toBe(404);
      expect(failure.data).toEqual({ error: "Attribute not found" });
    });

    test("returns 404 for an option under another attribute", async () => {
      const attribute = await createTestAttribute("Owner");
      const other = await createTestAttribute("Other");
      const option = await createTestAttributeOption(other.id, "Stray", 0);

      const failure = await adminApiTestTransport({
        body: { text: "Hijack" },
        method: "PUT",
        path: `/api/admin/attributes/${attribute.id}/options/${option.id}`,
      });
      expect(failure.status).toBe(404);
      expect(failure.data).toEqual({ error: "Attribute option not found" });
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

      const answered = await adminApiTestTransport({
        body: { confirm_identifier: "5 minutes" },
        method: "DELETE",
        path: `/api/admin/attributes/${attribute.id}/options/${option.id}`,
      });
      expect(answered.status).toBe(200);
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

      const failure = await adminApiTestTransport({
        body: { confirm_identifier: "wrong" },
        method: "DELETE",
        path: `/api/admin/attributes/${attribute.id}/options/${option.id}`,
      });
      expect(failure.status).toBe(400);
      expect(failure.data).toEqual({
        error:
          "Option text does not match. Please provide the exact option text in confirm_identifier.",
      });
      expect(
        (await getAttributeWithOptions(attribute.id))?.options.length,
      ).toBe(1);
    });
  });
});
