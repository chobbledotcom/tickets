/**
 * What a create submission is allowed to say, and what it is told back.
 *
 * The one-off template promises a date, so a blank one is refused before
 * anything is written. An editor may create a listing but may not set the
 * webhook URL or the defaults flag, because both decide where attendee
 * details are posted.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllListings } from "#db/listings/records.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildCreateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { testListingInput } from "#test-utils/factories.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { mockMultipartRequest } from "#test-utils/mocks.ts";
import {
  adminMultipartPost,
  createTestEditorSession,
  testCsrfToken,
} from "#test-utils/session.ts";

const DATE_REQUIRED = "A date is required for one-off events";

const oneOffForm = (name: string, date: string) => ({
  ...buildCreateListingForm(
    testListingInput({ date, listingType: "standard", name }),
  ),
  template_id: "one-off-event",
});

const storedListing = async (name: string) =>
  (await getAllListings()).find((one) => one.name === name);

describeWithEnv("creating a one-off event", { db: true }, () => {
  test("refuses a blank date and says why", async () => {
    const { response } = await adminMultipartPost(
      "/admin/listing",
      oneOffForm("No Date", ""),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(DATE_REQUIRED);
    expect(await storedListing("No Date")).toBeUndefined();
  });

  test("accepts the same form once a date is filled in", async () => {
    const { response } = await adminMultipartPost(
      "/admin/listing",
      oneOffForm("With Date", "2026-09-01T10:00"),
    );

    expectRedirect(response);
    expect(await storedListing("With Date")).toBeDefined();
  });

  test("does not ask a daily listing for a date", async () => {
    // The date rule is the one-off template's alone, so a daily submission
    // carrying the same template id is judged on its own shape.
    const { response } = await adminMultipartPost("/admin/listing", {
      ...buildCreateListingForm(
        testListingInput({ listingType: "daily", name: "Every Week" }),
      ),
      template_id: "one-off-event",
    });

    expectRedirect(response);
    expect(await storedListing("Every Week")).toBeDefined();
  });
});

describeWithEnv("a rejected create", { db: true }, () => {
  test("comes back at 400 with the Customise box as it was left", async () => {
    const { response } = await adminMultipartPost("/admin/listing", {
      ...buildCreateListingForm(testListingInput({ name: "" })),
      customise: "1",
      template_id: "weekly-event",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      '<input checked id="customise-listing" name="customise"',
    );
  });

  test("leaves the Customise box shut when it was not ticked", async () => {
    const { response } = await adminMultipartPost("/admin/listing", {
      ...buildCreateListingForm(testListingInput({ name: "" })),
      template_id: "weekly-event",
    });

    expect(await response.text()).toContain(
      '<input id="customise-listing" name="customise"',
    );
  });
});

describeWithEnv("what a create writes down", { db: true }, () => {
  test("records the new listing in the activity log", async () => {
    await adminMultipartPost(
      "/admin/listing",
      buildCreateListingForm(testListingInput({ name: "Logged Create" })),
    );

    expect(await activityMessages()).toContain(
      "Listing 'Logged Create' created",
    );
  });
});

describeWithEnv("an editor creating a listing", { db: true }, () => {
  /** Post a create as an editor, whatever they put in the form. */
  const editorCreate = async (
    cookie: string,
    values: TestFormValues,
  ): Promise<Response> => {
    const { handleRequest } = await import("#routes");
    return await handleRequest(
      mockMultipartRequest(
        "/admin/listing",
        { ...values, csrf_token: await testCsrfToken() },
        cookie,
      ),
    );
  };

  test("cannot set the webhook URL that attendee details are posted to", async () => {
    const { cookie } = await createTestEditorSession();

    await editorCreate(cookie, {
      ...buildCreateListingForm(
        testListingInput({
          name: "Editor Webhook",
          webhookUrl: "https://attacker.example.com/steal",
        }),
      ),
    });

    expect((await storedListing("Editor Webhook"))?.webhook_url).toBe("");
  });

  test("cannot switch the new listing on to the site defaults", async () => {
    const { cookie } = await createTestEditorSession();

    await editorCreate(cookie, {
      ...buildCreateListingForm(
        testListingInput({ name: "Editor Defaults", useDefaults: true }),
      ),
    });

    expect((await storedListing("Editor Defaults"))?.use_defaults).toBe(false);
  });
});
