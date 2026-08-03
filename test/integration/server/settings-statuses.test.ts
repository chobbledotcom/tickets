/**
 * The attendee-status routes, in the cases a click cannot reach: a name box a
 * browser would never let anybody leave empty, an address nothing links to, a
 * status somebody is already booked in on, and the arms that only a rejected
 * write reaches. The links each row carries and the read-only rendering are
 * here too, as is the one delete that must succeed.
 *
 * The organiser's own journey through this page — writing the list, giving a
 * job to a new status, taking a spare one away, putting them in order — is
 * told in the story "The organiser names the states a booking can be in".
 */

/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllActivityLog } from "#shared/db/activityLog.ts";
import {
  attendeeStatuses,
  getAttendeeStatus,
} from "#shared/db/attendee-statuses.ts";
import { getDb } from "#shared/db/client.ts";
import {
  expectFlashRedirect,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  adminFormPost,
  adminGet,
  withTestSession,
} from "#test-utils/session.ts";

/* jscpd:ignore-end */

const PATH = "/admin/settings/statuses";

/** The seed status created by the migration (public + paid default). */
const seedStatus = async () => (await attendeeStatuses.getAll())[0]!;

describeWithEnv("server (admin attendee statuses)", { db: true }, () => {
  describe("GET /admin/settings/statuses", () => {
    testRequiresAuth(PATH);

    test("links status names to their canonical entity pages", async () => {
      const seed = await seedStatus();
      const html = await (await adminGet(PATH)).text();
      expect(html).toContain(`href="${PATH}/${seed.id}"`);
      expect(html).not.toContain(`href="${PATH}/${seed.id}/edit"`);
    });

    test("shows status names without links in read-only mode", async () => {
      using _env = withEnv({
        READ_ONLY_FROM: "2020-01-01T00:00:00.000Z",
      });
      const seed = await seedStatus();
      const html = await (await adminGet(PATH)).text();
      expect(html).toContain(seed.name);
      expect(html).not.toContain(`href="${PATH}/${seed.id}"`);
    });
  });

  describe("POST /admin/settings/statuses (create)", () => {
    test("logs a created status with its full activity name", async () => {
      await adminFormPost(PATH, { name: "Invited" });

      const entries = await withTestSession(() => getAllActivityLog());
      expect(entries.map((entry) => entry.message)).toContain(
        "Attendee status 'Invited' created",
      );
    });

    test("rejects a missing name", async () => {
      const { response } = await adminFormPost(PATH, { name: "" });
      await expectFlashRedirect(
        `${PATH}/new`,
        "Please enter a name",
        false,
      )(response);
    });
  });

  describe("GET /admin/settings/statuses/:id/delete", () => {
    testRequiresAuth(`${PATH}/1/delete`);

    test("returns 404 for a missing status", async () => {
      const response = await adminGet(`${PATH}/9999/delete`);
      expect(response.status).toBe(404);
    });
  });

  describe("POST /admin/settings/statuses/:id/delete", () => {
    test("refuses to delete a status that is in use", async () => {
      const inUse = await attendeeStatuses.table.insert({ name: "Active" });
      // A current `created` keeps this booking-less attendee out of the
      // orphaned-record auto-purge so it still counts as "in use".
      await getDb().execute({
        args: [new Date().toISOString(), inUse.id],
        sql: "INSERT INTO attendees (created, pii_blob, status_id) VALUES (?, '', ?)",
      });
      const { response } = await adminFormPost(`${PATH}/${inUse.id}/delete`, {
        confirm_identifier: "Active",
      });
      await expectFlashRedirect(
        `${PATH}/${inUse.id}/delete`,
        "This status is in use by attendees",
        false,
      )(response);
    });

    test("deletes a spare, unused status", async () => {
      const spare = await attendeeStatuses.table.insert({ name: "Disposable" });
      const { response } = await adminFormPost(`${PATH}/${spare.id}/delete`, {
        confirm_identifier: "Disposable",
      });
      await expectFlashRedirect(PATH, "Status deleted")(response);
      expect(await getAttendeeStatus(spare.id)).toBeNull();
    });

    test("returns 404 deleting a missing status", async () => {
      const { response } = await adminFormPost(`${PATH}/9999/delete`, {
        confirm_identifier: "anything",
      });
      expect(response.status).toBe(404);
    });

    test("refuses to delete the paid default", async () => {
      // Move the paid default onto a new (non-public) status, then delete it.
      await adminFormPost(PATH, { is_paid_default: "1", name: "Settled" });
      const settled = (await attendeeStatuses.getAll()).find(
        (s) => s.name === "Settled",
      )!;
      const { response } = await adminFormPost(`${PATH}/${settled.id}/delete`, {
        confirm_identifier: "Settled",
      });
      await expectFlashRedirect(
        `${PATH}/${settled.id}/delete`,
        "Choose another paid default before deleting this status",
        false,
      )(response);
    });
  });

  describe("POST /admin/settings/statuses/:id/move", () => {
    test("move at the boundary is a no-op", async () => {
      const seed = await seedStatus();
      const { response } = await adminFormPost(`${PATH}/${seed.id}/move-up`);
      await expectFlashRedirect(PATH, "Status moved")(response);
    });

    test("returns 404 moving a missing status", async () => {
      const { response } = await adminFormPost(`${PATH}/9999/move-up`);
      expect(response.status).toBe(404);
    });
  });
});
