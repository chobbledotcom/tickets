/**
 * The listing admin page's management tabs: what each panel puts on screen, and
 * which groups the edit form ticks after a rejected save.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { listingGroups } from "#db/groups.ts";
import { listingQuestions } from "#db/questions/queries.ts";
import type { PageCtx } from "#routes/admin/entity-pages.ts";
import {
  type LoadedListing,
  loadListingForPage,
} from "#routes/admin/listing-page-data.ts";
import {
  loadListingAttributesPanel,
  loadListingEditPanel,
  loadListingImagesPanel,
  loadListingQrPanel,
  loadListingQuestionsPanel,
} from "#routes/admin/listing-page-management-panels.ts";
import type { AuthSession } from "#routes/auth.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createQuestion } from "#test-utils/questions/helpers.ts";
import { withTestSession } from "#test-utils/session.ts";

const SESSION: AuthSession = {
  adminLevel: "owner",
  token: "t",
  userId: 1,
  wrappedDataKey: null,
};

const CTX: PageCtx = {
  baseUrl: "https://example.test",
  query: new URLSearchParams(),
  returnUrl: "/admin/listings/1",
  session: SESSION,
  tabHref: (slug: string) => `/admin/listings/1/${slug}`,
};

const loaded = async (id: number): Promise<LoadedListing> => {
  const listing = await loadListingForPage(id);
  if (!listing) throw new Error(`no listing ${id}`);
  return listing;
};

const checkboxId = (tag: string): number => {
  const found = /value="(\d+)"/.exec(tag);
  if (!found) throw new Error(`checkbox with no value: ${tag}`);
  return Number(found[1]);
};

/** The ids ticked under one checkbox name, read back out of the markup. */
const ticked =
  (name: string) =>
  (html: string): number[] =>
    html
      .split("<input")
      .filter(
        (tag) => tag.includes(`name="${name}"`) && tag.includes("checked"),
      )
      .map(checkboxId);

const tickedGroups = ticked("group_ids");
const tickedQuestions = ticked("question_ids");
const tickedOptions = ticked("option_ids");

const editHtml = async (
  listingId: number,
  error?: string,
  selectedGroupIds?: number[],
): Promise<string> =>
  await withTestSession(async () =>
    String(
      await loadListingEditPanel(
        await loaded(listingId),
        CTX,
        error,
        selectedGroupIds,
      ),
    ),
  );

/** A listing that belongs to one group, beside a second group it is not in. */
const listingInAGroup = async (): Promise<{
  listingId: number;
  memberOf: number;
  otherGroup: number;
}> => {
  const listing = await createTestListing({ name: "Autumn Fair" });
  const memberOf = await createTestGroup({ name: "Weekends" });
  const otherGroup = await createTestGroup({ name: "Evenings" });
  await listingGroups.setIds(listing.id, [memberOf.id]);
  return {
    listingId: listing.id,
    memberOf: memberOf.id,
    otherGroup: otherGroup.id,
  };
};

describeWithEnv(
  "the listing page's management tabs",
  { db: true, storage: "local" },
  () => {
    describe("the edit tab", () => {
      test("shows the listing's stored name", async () => {
        const listing = await createTestListing({ name: "Autumn Fair" });
        expect(await editHtml(listing.id)).toContain("Autumn Fair");
      });

      test("ticks the groups the listing is stored in", async () => {
        const { listingId, memberOf } = await listingInAGroup();
        expect(tickedGroups(await editHtml(listingId))).toEqual([memberOf]);
      });

      test("ticks the groups the operator submitted, not the stored ones", async () => {
        const { listingId, otherGroup } = await listingInAGroup();
        const html = await editHtml(listingId, "Nope", [otherGroup]);
        expect(tickedGroups(html)).toEqual([otherGroup]);
      });

      test("ticks nothing when the operator cleared every group", async () => {
        // An empty submission is a real choice. Falling back to the stored ids
        // would put the listing back in the group it was just taken out of.
        const { listingId } = await listingInAGroup();
        expect(tickedGroups(await editHtml(listingId, "Nope", []))).toEqual([]);
      });

      test("shows the message when a save was rejected", async () => {
        const listing = await createTestListing({});
        expect(await editHtml(listing.id, "Slug is taken")).toContain(
          "Slug is taken",
        );
      });

      test("shows no message when the tab is opened normally", async () => {
        const listing = await createTestListing({});
        expect(await editHtml(listing.id)).not.toContain("Slug is taken");
      });
    });

    describe("the images tab", () => {
      test("comes back to the listing after an upload", async () => {
        const listing = await createTestListing({});
        const html = await withTestSession(async () =>
          String(await loadListingImagesPanel(await loaded(listing.id))),
        );
        expect(html).toContain(`/admin/listing/${listing.id}`);
      });
    });

    describe("the questions tab", () => {
      /** One assigned question and one unassigned, as the tab renders them. */
      const questionsHtml = async (): Promise<{
        assigned: number;
        html: string;
        unassigned: number;
      }> => {
        const listing = await createTestListing({});
        const assigned = await createQuestion("Any allergies?");
        const unassigned = await createQuestion("Parking needed?");
        await listingQuestions.setIds(listing.id, [assigned]);
        const html = await withTestSession(async () =>
          String(await loadListingQuestionsPanel(await loaded(listing.id))),
        );
        return { assigned, html, unassigned };
      };

      test("offers every question the site has", async () => {
        const { html } = await questionsHtml();
        expect(html).toContain("Any allergies?");
        expect(html).toContain("Parking needed?");
      });

      test("ticks only the questions this listing uses", async () => {
        const { assigned, html } = await questionsHtml();
        expect(tickedQuestions(html)).toEqual([assigned]);
      });
    });

    describe("the attributes tab", () => {
      /** One chosen option and one not, as the tab renders them. */
      const attributesHtml = async (): Promise<{
        chosen: number;
        html: string;
      }> => {
        const listing = await createTestListing({});
        const attribute = await createTestAttributeWithOptions("Access", [
          "Step free",
          "Stairs only",
        ]);
        const stepFree = attribute.options[0];
        if (!stepFree)
          throw new Error("the attribute kept none of its options");
        await assignTestAttributeOptions(listing.id, [stepFree]);
        const html = await withTestSession(async () =>
          String(await loadListingAttributesPanel(await loaded(listing.id))),
        );
        return { chosen: stepFree.id, html };
      };

      test("offers every option the attribute has", async () => {
        const { html } = await attributesHtml();
        expect(html).toContain("Step free");
        expect(html).toContain("Stairs only");
      });

      test("ticks only the options this listing shows", async () => {
        const { chosen, html } = await attributesHtml();
        expect(tickedOptions(html)).toEqual([chosen]);
      });
    });

    describe("the QR tab", () => {
      test("offers the booking-QR form for the listing", async () => {
        const listing = await createTestListing({ name: "Autumn Fair" });
        const html = await withTestSession(async () =>
          String(await loadListingQrPanel(await loaded(listing.id))),
        );
        expect(html).toContain(`/admin/listing/${listing.id}/qr`);
      });
    });
  },
);
