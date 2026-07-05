/**
 * Servicing §12 — activity log.
 *
 * The global activity log links each attendee_id to its record. A servicing
 * attendee_id must link to `/admin/servicing/:id`; a normal attendee_id still
 * links to `/admin/attendees/:id`. Both go through the single kind-aware link
 * builder from §0 (`attendeeAdminPath`) — no second copy of the dispatch.
 *
 * Implementation contract (test-first):
 *   - The activity log template's attendee ref link resolves through
 *     `attendeeAdminPath({ id, kind })` using a kind map the feature layer
 *     populates (the existing `ActivityLogRefs.attendees` name map is
 *     supplemented with each attendee's kind, or a parallel kind map).
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeAdminPath } from "#shared/attendee-links.ts";
import { ATTENDEE_KIND, SERVICING_KIND } from "#shared/db/attendees/kind.ts";
import {
  createRealAttendee,
  createServicingHold,
  describeWithEnv,
  renderAdminPage,
} from "#test-utils";

// jscpd:ignore-end

describe("servicing §12 — activity-log link routing", () => {
  test("attendeeAdminPath is the single builder the log calls (kind-aware)", () => {
    expect(attendeeAdminPath({ id: 99, kind: SERVICING_KIND })).toBe(
      "/admin/servicing/99",
    );
    expect(attendeeAdminPath({ id: 99, kind: ATTENDEE_KIND })).toBe(
      "/admin/attendees/99",
    );
  });
});

describeWithEnv(
  "servicing §12 — rendered activity log links",
  { db: true },
  () => {
    test("a logged servicing attendee_id links to /admin/servicing/:id", async () => {
      const { id } = await createServicingHold();
      const body = await renderAdminPage("/admin/log");
      expect(body).toContain(`/admin/servicing/${id}`);
      expect(body).not.toContain(`/admin/attendees/${id}`);
    });

    test("a logged normal attendee_id still links to /admin/attendees/:id", async () => {
      const { attendee } = await createRealAttendee();
      const body = await renderAdminPage("/admin/log");
      expect(body).toContain(`/admin/attendees/${attendee.id}`);
      expect(body).not.toContain(`/admin/servicing/${attendee.id}`);
    });
  },
);
