import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { pendingNotificationBadges } from "#templates/admin/attendee-notification-badges.tsx";

/** The flag columns one attendee read carries, named as the stored columns are. */
const flags = (
  email_owed: number,
  email_pending: number,
  webhooks_pending: number,
) => ({ email_owed, email_pending, webhooks_pending });

describe("pendingNotificationBadges", () => {
  test("an attendee whose sends were all accepted shows no pill", () => {
    expect(String(pendingNotificationBadges(flags(0, 0, 0)))).toBe("");
  });

  test("an owed online booking shows the red email pill", () => {
    expect(String(pendingNotificationBadges(flags(1, 1, 0)))).toBe(
      ' <span class="badge danger">Email not sent</span>',
    );
  });

  test("an admin-added booking shows the orange email pill", () => {
    expect(String(pendingNotificationBadges(flags(1, 2, 0)))).toBe(
      ' <span class="badge-warning">Email not sent</span>',
    );
  });

  test("a booking that still owes a webhook shows the red webhook pill", () => {
    expect(String(pendingNotificationBadges(flags(0, 0, 1)))).toBe(
      ' <span class="badge danger">Webhooks not sent</span>',
    );
  });

  test("a listing that no longer collects an email drops only the email pill", () => {
    expect(String(pendingNotificationBadges(flags(0, 2, 1)))).toBe(
      ' <span class="badge danger">Webhooks not sent</span>',
    );
  });

  test("both owed pills show in flag order, email first", () => {
    expect(String(pendingNotificationBadges(flags(1, 2, 1)))).toBe(
      ' <span class="badge-warning">Email not sent</span>,' +
        ' <span class="badge danger">Webhooks not sent</span>',
    );
  });
});
