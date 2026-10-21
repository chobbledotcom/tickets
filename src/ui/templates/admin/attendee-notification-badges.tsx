/**
 * The "email not sent" / "webhooks not sent" pills for a booking whose
 * notification send never got accepted. Red when the person booked online.
 * Orange when an admin added them by hand — the flag's stored value says
 * which. The booking wrote the value when it was made.
 */

import {
  emailBadgeOwed,
  PENDING_NOTIFICATION,
} from "#db/attendees/notification-flags.ts";
import { t } from "#i18n";
import { Badge } from "#templates/components/badge.tsx";
import type { Attendee } from "#types";

/** The flag columns every attendee read carries, with the email rule the read
 * resolved into `email_owed`. */
export type PendingNotificationFlags = Pick<
  Attendee,
  "email_owed" | "email_pending" | "webhooks_pending"
>;

/** One pill for a flag that is still up. None for a flag that is down. The
 * space keeps the pill off the name. JSX adds no space between expressions,
 * so a screen reader reads the name and the pill as one glued word. */
const pendingBadge = (value: number, label: string): JSX.Element | null => {
  if (value === PENDING_NOTIFICATION.none) return null;
  return (
    <>
      {" "}
      <Badge
        variant={value === PENDING_NOTIFICATION.online ? "danger" : "warning"}
      >
        {label}
      </Badge>
    </>
  );
};

/** The pending-notification pills for one attendee, in flag order. Empty when
 * every send the booking owed got accepted. The email pill follows the same
 * read-time rule as the dashboard count: no booked listing collects an email
 * any more, no email badge. */
export const pendingNotificationBadges = (
  attendee: PendingNotificationFlags,
): JSX.Element[] =>
  [
    emailBadgeOwed(attendee)
      ? pendingBadge(
          attendee.email_pending ?? PENDING_NOTIFICATION.none,
          t("attendees.badge.email_not_sent"),
        )
      : null,
    pendingBadge(
      attendee.webhooks_pending,
      t("attendees.badge.webhooks_not_sent"),
    ),
  ].filter((badge) => badge !== null);
