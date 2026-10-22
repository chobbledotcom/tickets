import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { pendingNotificationBadges } from "#templates/admin/attendee-notification-badges.tsx";

/** The flag columns one attendee read carries, named as the stored columns are. */
const flags = (
  email_owed: number,
  email_pending: number,
  webhooks_pending: number,
) => ({ email_owed, email_pending, webhooks_pending });

/** The pill combinations the rendered surface tests cannot reach: the empty
 * pair and the owed webhooks beside a dropped email. */
describe("pendingNotificationBadges", () => {
  test("an attendee whose sends were all accepted shows no pill", () => {
    expect(String(pendingNotificationBadges(flags(0, 0, 0)))).toBe("");
  });

  test("a listing that no longer collects an email drops only the email pill", () => {
    expect(String(pendingNotificationBadges(flags(0, 2, 1)))).toBe(
      ' <span class="badge danger">Webhooks not sent</span>',
    );
  });
});
