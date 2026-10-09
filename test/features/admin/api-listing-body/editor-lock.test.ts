/** The role boundary of the JSON listing body: an editor session cannot set
 *  the fields the dashboard freezes, and an owner session can. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bodyToUpdateInput } from "#routes/admin/api-listing-body.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describeWithEnv("Admin API listing body role boundary", { db: true }, () => {
  test("an owner session sets the listing state through the body", async () => {
    const result = await bodyToUpdateInput(
      { active: false, max_attendees: 10, name: "Owner State" },
      testListingWithCount({
        active: true,
        max_attendees: 10,
        name: "Owner State",
      }),
      { adminLevel: "owner" },
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.value.active).toBe(false);
  });

  test("an editor session keeps the frozen fields at their stored values", async () => {
    const result = await bodyToUpdateInput(
      {
        active: false,
        max_attendees: 10,
        name: "Editor State",
        use_defaults: true,
        webhook_url: "https://example.com/hook",
      },
      testListingWithCount({
        active: true,
        max_attendees: 10,
        name: "Editor State",
        use_defaults: false,
        webhook_url: "",
      }),
      { adminLevel: "editor" },
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.value.active).toBe(true);
    expect(result.value.useDefaults).toBe(false);
    expect(result.value.webhookUrl).toBe("");
  });
});
