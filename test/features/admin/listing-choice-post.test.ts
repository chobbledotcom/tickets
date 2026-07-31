import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createListingChoicePost } from "#routes/admin/listing-choice-post.ts";
import type { FormParams } from "#shared/form-data.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest } from "#test-utils/mocks.ts";
import { testCookie, testCsrfToken } from "#test-utils/session.ts";
import { enableFeature } from "#test-utils/settings.ts";

/** Build the handler under test with a spy standing in for the id writer. */
const makeHandler = (config?: {
  readIds?: (form: FormParams, fieldName: string) => number[];
}) => {
  const saved: { listingId: number; ids: number[] }[] = [];
  const handler = createListingChoicePost({
    feature: "questions",
    fieldName: "choice_ids",
    label: "Widgets",
    noun: "widget",
    ...(config?.readIds ? { readIds: config.readIds } : {}),
    saveIds: (listingId, ids) => {
      saved.push({ ids, listingId });
      return Promise.resolve();
    },
    tab: "widgets",
  });
  return { handler, saved };
};

const postChoices = async (
  handler: ReturnType<typeof makeHandler>["handler"],
  id: number,
  data: Record<string, string | string[]>,
): Promise<Response> =>
  handler(
    mockFormRequest(
      `/admin/listing/${id}/widgets`,
      { csrf_token: await testCsrfToken(), ...data },
      await testCookie(),
    ),
    { id },
  );

describeWithEnv("admin listing choice post", { db: true }, () => {
  test("saves the posted ids, logs the plural count, and redirects", async () => {
    await enableFeature("questions");
    const listing = await createTestListing({ name: "Fair" });
    const { handler, saved } = makeHandler();

    const response = await postChoices(handler, listing.id, {
      choice_ids: ["4", "7"],
    });

    expect(saved).toEqual([{ ids: [4, 7], listingId: listing.id }]);
    expectRedirect(response, `/admin/listing/${listing.id}/widgets`);
    expectFlash(response, "Widgets updated");
    expect(await activityMessages()).toContain(
      "Widgets updated for 'Fair' (2 widgets)",
    );
  });

  test("logs a single choice in the singular", async () => {
    await enableFeature("questions");
    const listing = await createTestListing({ name: "Solo" });
    const { handler } = makeHandler();

    const response = await postChoices(handler, listing.id, {
      choice_ids: "9",
    });

    response.body?.cancel();
    expect(await activityMessages()).toContain(
      "Widgets updated for 'Solo' (1 widget)",
    );
  });

  test("hands a custom id reader the configured field name", async () => {
    await enableFeature("questions");
    const listing = await createTestListing({ name: "Custom" });
    const seen: string[] = [];
    const { handler, saved } = makeHandler({
      readIds: (form, fieldName) => {
        seen.push(fieldName);
        return form.getNumberArray(fieldName);
      },
    });

    const response = await postChoices(handler, listing.id, {
      choice_ids: "3",
    });

    response.body?.cancel();
    expect(seen).toEqual(["choice_ids"]);
    expect(saved).toEqual([{ ids: [3], listingId: listing.id }]);
  });

  test("is not found while the feature is off", async () => {
    const listing = await createTestListing({ name: "Gated" });
    const { handler, saved } = makeHandler();

    const response = await postChoices(handler, listing.id, {
      choice_ids: "1",
    });

    expect(response.status).toBe(404);
    expect(saved).toEqual([]);
  });
});
