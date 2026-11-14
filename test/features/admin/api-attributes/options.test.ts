import type { TransactionMode } from "@libsql/client";
import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getAttributeWithOptions } from "#db/attributes.ts";
import { getDb } from "#db/client.ts";
import {
  type AdminApiResponse,
  adminApiChildCreate,
} from "#shared/admin-api-client.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiAttribute,
} from "#shared/admin-api-resources.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  adminApiTestTransport,
  expectTextChildCreateRefusals,
} from "#test-utils/admin-api-transport.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAttribute,
  createTestAttributeOption,
} from "#test-utils/db-helpers/attributes.ts";
import { withEnv } from "#test-utils/env.ts";

const { attributes } = ADMIN_API_RESOURCES;

/** A stored attribute that holds one option. */
const attributeWithOption = async (name: string, text: string) => {
  const attribute = await createTestAttribute(name);
  const option = await createTestAttributeOption(attribute.id, text, 0);
  return { attribute, option };
};

/** One request to an option's own route. */
const optionRoute = (
  method: "DELETE" | "PUT",
  attributeId: number,
  optionId: number,
  body?: Record<string, unknown>,
): Promise<AdminApiResponse> =>
  adminApiTestTransport({
    body,
    method,
    path: `/api/admin/attributes/${attributeId}/options/${optionId}`,
  });

/** Send one accepted request to a fresh attribute's only option. */
const acceptedForNewOption = async (
  names: { attribute: string; option: string },
  method: "DELETE" | "PUT",
  body: Record<string, unknown>,
) => {
  const { attribute, option } = await attributeWithOption(
    names.attribute,
    names.option,
  );
  const answered = await optionRoute(method, attribute.id, option.id, body);
  expect(answered.status).toBe(200);
  return { answered, attribute, option };
};

/** Expect one option route to refuse with this status and message. */
const expectRefusal = async (
  sent: Promise<AdminApiResponse>,
  status: number,
  error: string,
): Promise<void> => {
  const failure = await sent;
  expect(failure.status).toBe(status);
  expect(failure.data).toEqual({ error });
};

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
      assertArrayIncludes(await activityMessages(), [
        "Attribute option '20-30 minutes' added to Game Length",
      ]);
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
        assertArrayIncludes(
          answered.attribute.options.map((option) => option.text),
          ["20-200 guests"],
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

    test("refuses a missing text and an unknown attribute", async () => {
      const attribute = await createTestAttribute("No Text");

      await expectTextChildCreateRefusals(attributes, "options", attribute.id);
    });
  });

  describe("PUT /api/admin/attributes/:attributeId/options/:optionId", () => {
    test("renames an option", async () => {
      const { answered, attribute, option } = await acceptedForNewOption(
        { attribute: "Player Count", option: "2 players" },
        "PUT",
        { text: "2-4 players" },
      );
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
      assertArrayIncludes(await activityMessages(), [
        "Attribute option '2-4 players' updated in Player Count",
      ]);
    });

    test("returns 404 for an unknown attribute", async () => {
      await expectRefusal(
        optionRoute("PUT", 99999, 1),
        404,
        "Attribute not found",
      );
    });

    test("returns 404 for an option under another attribute", async () => {
      const attribute = await createTestAttribute("Owner");
      const { option } = await attributeWithOption("Other", "Stray");

      await expectRefusal(
        optionRoute("PUT", attribute.id, option.id, { text: "Hijack" }),
        404,
        "Attribute option not found",
      );
    });
  });

  describe("DELETE /api/admin/attributes/:attributeId/options/:optionId", () => {
    test("deletes an option with the right confirmation", async () => {
      const { attribute } = await acceptedForNewOption(
        { attribute: "Game Length", option: "5 minutes" },
        "DELETE",
        { confirm_identifier: "5 minutes" },
      );
      expect((await getAttributeWithOptions(attribute.id))?.options).toEqual(
        [],
      );
      assertArrayIncludes(await activityMessages(), [
        "Attribute option '5 minutes' deleted from Game Length",
      ]);
    });

    test("rejects a delete with the wrong confirmation", async () => {
      const { attribute, option } = await attributeWithOption(
        "Player Count",
        "1 player",
      );

      await expectRefusal(
        optionRoute("DELETE", attribute.id, option.id, {
          confirm_identifier: "wrong",
        }),
        400,
        "Option text does not match. Please provide the exact option text in confirm_identifier.",
      );
      expect(
        (await getAttributeWithOptions(attribute.id))?.options.length,
      ).toBe(1);
    });
  });
});
