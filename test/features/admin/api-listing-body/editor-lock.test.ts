/** The closed fields of the JSON listing body: a writer who cannot set a field
 *  is refused when the body names it, whatever the value. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bodyToUpdateInput } from "#routes/admin/api-listing-body.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import { editorSession, requestAs } from "#test-utils/api/admin-json.ts";
import { expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import { testListingWithCount } from "#test-utils/factories.ts";
import type { AdminLevel } from "#types";

const STORED = testListingWithCount({
  active: true,
  maxAttendees: 10,
  name: "Hall",
  useDefaults: false,
  webhookUrl: "",
});

/** The refusal or the read value of one update body from a writer. */
const answerFor = async (
  adminLevel: AdminLevel,
  extra: Record<string, unknown>,
) => {
  const result = await bodyToUpdateInput(
    { max_attendees: 10, name: "Hall", ...extra },
    STORED,
    { adminLevel },
  );
  return result.ok ? "read" : result.error;
};

describeWithEnv("Admin API listing body closed fields", { db: true }, () => {
  test("an owner session sets the listing state through the body", async () => {
    const result = await bodyToUpdateInput(
      { active: false, max_attendees: 10, name: "Hall" },
      STORED,
      { adminLevel: "owner" },
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.value.active).toBe(false);
  });

  test("an editor body that names a locked field is refused, even at its stored value", async () => {
    expect([
      await answerFor("editor", { active: true }),
      await answerFor("editor", { use_defaults: false }),
      await answerFor("editor", { webhook_url: "" }),
      await answerFor("editor", { description: "Open to all" }),
    ]).toEqual([
      "editors cannot set active",
      "editors cannot set use_defaults",
      "editors cannot set webhook_url",
      "read",
    ]);
  });

  test("an editor update that omits the locked fields succeeds at the boundary", async () => {
    const listing = await createTestListing({ name: "Editor Lock HTTP" });
    const path = `/api/admin/listings/${listing.id}`;
    const session = await editorSession();

    // The schema fills every declared key before it parses the body. A
    // declared key that holds no value is not a supplied key for the
    // closed-field check, or every editor update would name the locked
    // fields.
    const response = await requestAs(session, path, {
      body: { description: "Open to all", name: "Edited" },
      method: "PUT",
    });
    expect(response.status).toBe(200);

    for (const [field, value] of [
      ["active", false],
      ["use_defaults", false],
      ["webhook_url", ""],
    ] as const) {
      await expectApiError(
        requestAs(session, path, {
          body: { [field]: value, name: "Edited" },
          method: "PUT",
        }),
        400,
        `editors cannot set ${field}`,
      );
    }
  });

  test("the demo refuses a webhook address", async () => {
    setDemoModeForTest(true);
    try {
      expect(
        await answerFor("owner", { webhook_url: "https://example.com/hook" }),
      ).toBe("webhook_url cannot be set in the demo");
    } finally {
      setDemoModeForTest(false);
    }
  });

  test("a site building field is refused while site building is off, and read while it is on", async () => {
    const off = await answerFor("owner", { assign_built_site: false });
    using _env = withEnv({ CAN_BUILD_SITES: "true" });
    expect([
      off,
      await answerFor("owner", { assign_built_site: false }),
    ]).toEqual(["assign_built_site needs site building turned on", "read"]);
  });
});
