import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withExternalLinkWriteFault } from "#test-utils/db-fault.ts";
import {
  createBooking,
  rosterAttendeeIds,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  createSource,
  linksPath,
  SOURCE_BODY,
} from "#test-utils/external-sources.ts";
import { apiRequest } from "#test-utils/session.ts";
import {
  featureSetting,
  useSetting,
  withSetting,
} from "#test-utils/settings.ts";

/** One listing and one source, the two things a linked create needs. */
const setup = async (name: string, sourceName = SOURCE_BODY.name) => ({
  listingId: (await createTestListing({ name })).id,
  sourceId: (
    (await createSource({ ...SOURCE_BODY, name: sourceName })).source as {
      id: number;
    }
  ).id,
});

/** One booking that names an external source and the attendee's id there. */
const bookLinked = (
  listingId: number,
  sourceId: number,
  externalId: string,
  extra: Record<string, unknown> = {},
): Promise<Response> =>
  createBooking(listingId, {
    external_id: externalId,
    external_source_id: sourceId,
    ...extra,
  });

/** The source's links for one external id, as the links route answers. */
const linksFor = async (
  sourceId: number,
  externalId: string,
): Promise<Record<string, unknown>[]> =>
  (
    await assertJson(
      apiRequest(
        `${linksPath(sourceId)}?external_id=${encodeURIComponent(externalId)}`,
      ),
      200,
    )
  ).links;

describeWithEnv(
  "Admin API - POST /api/admin/attendees with an external id",
  { db: true },
  () => {
    useSetting(featureSetting("externalSources"));

    test("stores the attendee and its link together", async () => {
      const { listingId, sourceId } = await setup("Linked Fair");
      const created = await assertJson(
        bookLinked(listingId, sourceId, "INV-1"),
        201,
      );
      expect(await linksFor(sourceId, "INV-1")).toMatchObject([
        {
          external_id: "INV-1",
          link_id: created.attendee.id,
          link_type: "attendee",
          source_id: sourceId,
        },
      ]);
    });

    test("a retry with the same external id answers with the stored attendee", async () => {
      const { listingId, sourceId } = await setup("Retry Fair");
      const first = await assertJson(
        bookLinked(listingId, sourceId, "INV-2"),
        201,
      );
      const retry = await assertJson(
        bookLinked(listingId, sourceId, "INV-2", { name: "Someone Else" }),
        200,
      );
      expect(retry.attendee.id).toBe(first.attendee.id);
      expect(retry.attendee.name).toBe("Ada Lovelace");
      expect(await rosterAttendeeIds(listingId)).toEqual([first.attendee.id]);
      expect(await linksFor(sourceId, "INV-2")).toHaveLength(1);
    });

    test("two creates that race under one external id store one attendee", async () => {
      const { listingId, sourceId } = await setup("Race Fair");
      const responses = await Promise.all([
        bookLinked(listingId, sourceId, "INV-3"),
        bookLinked(listingId, sourceId, "INV-3"),
      ]);
      const answers = await Promise.all(
        responses.map((response) => response.json()),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 201,
      ]);
      expect(answers[0].attendee.id).toBe(answers[1].attendee.id);
      expect(await rosterAttendeeIds(listingId)).toHaveLength(1);
      expect(await linksFor(sourceId, "INV-3")).toHaveLength(1);
    });

    test("the same external id at another source is a separate attendee", async () => {
      const first = await setup("Two Sources Fair");
      const secondSource = await setup("Other Fair", "Diary");
      const a = await assertJson(
        bookLinked(first.listingId, first.sourceId, "SHARED"),
        201,
      );
      const b = await assertJson(
        bookLinked(first.listingId, secondSource.sourceId, "SHARED"),
        201,
      );
      expect(b.attendee.id).not.toBe(a.attendee.id);
    });

    test("a create whose link write fails stores no attendee, and a retry succeeds", async () => {
      const { listingId, sourceId } = await setup("Fault Fair");
      await expect(
        withExternalLinkWriteFault(() =>
          bookLinked(listingId, sourceId, "INV-4"),
        ),
      ).rejects.toThrow("external link write refused");
      expect(await rosterAttendeeIds(listingId)).toEqual([]);
      expect(await linksFor(sourceId, "INV-4")).toEqual([]);

      const retry = await assertJson(
        bookLinked(listingId, sourceId, "INV-4"),
        201,
      );
      expect(await rosterAttendeeIds(listingId)).toEqual([retry.attendee.id]);
      expect(await linksFor(sourceId, "INV-4")).toHaveLength(1);
    });

    test("a create with no external id writes no link", async () => {
      const { listingId, sourceId } = await setup("Plain Fair");
      await assertJson(createBooking(listingId), 201);
      expect(
        (await assertJson(apiRequest(linksPath(sourceId)), 200)).links,
      ).toEqual([]);
    });

    describe("refusals", () => {
      /** Post the body, expect the refusal, and expect no attendee stored. */
      const refused = async (
        body: (sourceId: number) => Record<string, unknown>,
        status: number,
        message: string,
        features = featureSetting("externalSources"),
      ): Promise<void> => {
        const { listingId, sourceId } = await setup("Refusal Fair");
        await withSetting(features, () =>
          assertJson(createBooking(listingId, body(sourceId)), status, (r) =>
            expect(r.error).toBe(message),
          ),
        );
        expect(await rosterAttendeeIds(listingId)).toEqual([]);
      };

      const together = "external_source_id and external_id go together";

      test("an id without a source", () =>
        refused(() => ({ external_id: "INV-5" }), 400, together));

      test("a source without an id", () =>
        refused(
          (sourceId) => ({ external_source_id: sourceId }),
          400,
          together,
        ));

      test("a source id that is not a whole number", () =>
        refused(
          () => ({ external_id: "INV-5", external_source_id: "1" }),
          400,
          "external_source_id must be a whole number of 1 or more",
        ));

      test("an empty external id", () =>
        refused(
          (sourceId) => ({ external_id: "", external_source_id: sourceId }),
          400,
          "external_id is required",
        ));

      test("an external id that is too long", () =>
        refused(
          (sourceId) => ({
            external_id: "x".repeat(251),
            external_source_id: sourceId,
          }),
          400,
          "external_id must be 250 characters or fewer",
        ));

      test("a source that does not exist", () =>
        refused(
          () => ({ external_id: "INV-5", external_source_id: 9999 }),
          400,
          "Unknown external source",
        ));

      test("answers 403 while the external sources feature is off", () =>
        refused(
          (sourceId) => ({
            external_id: "INV-6",
            external_source_id: sourceId,
          }),
          403,
          "The external sources feature is disabled. Turn it on in Settings, then try again.",
          featureSetting(),
        ));
    });
  },
);
