/**
 * The "email not sent" / "webhooks not sent" pills for a booking whose
 * notification send never got accepted. Red when the person booked online.
 * Orange when an admin added them by hand — the flag's stored value says
 * which. The booking wrote the value when it was made.
 */

import { PENDING_NOTIFICATION } from "#db/attendees/notification-flags.ts";
import { t } from "#i18n";
import { Badge } from "#templates/components/badge.tsx";
import type { Attendee } from "#types";

/** The two flag columns every attendee row carries. */
export type PendingNotificationFlags = Pick<
  Attendee,
  "email_pending" | "webhooks_pending"
>;

/** One pill for a flag that is still up. None for a flag that is down. */
const pendingBadge = (value: number, label: string): JSX.Element | null => {
  if (value === PENDING_NOTIFICATION.none) return null;
  return (
    <Badge
      variant={value === PENDING_NOTIFICATION.online ? "danger" : "warning"}
    >
      {label}
    </Badge>
  );
};

/** The pending-notification pills for one attendee, in flag order. Empty when
 * every send the booking owed got accepted. */
export const pendingNotificationBadges = ({
  email_pending,
  webhooks_pending,
}: PendingNotificationFlags): JSX.Element[] =>
  [
    pendingBadge(email_pending, t("attendees.badge.email_not_sent")),
    pendingBadge(webhooks_pending, t("attendees.badge.webhooks_not_sent")),
  ].filter((badge) => badge !== null);
