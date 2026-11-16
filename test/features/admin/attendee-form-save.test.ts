import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { buildTaxSavePlan } from "#shared/tax/save.ts";
import { readTaxAssessments } from "#shared/tax/store.ts";
import { expectHtmlResponse } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withDbFault } from "#test-utils/db-fault.ts";
import { buildAttendeeEditForm } from "#test-utils/db-helpers/attendees.ts";
import { listingWithAttendee } from "#test-utils/db-helpers/listing-attendee.ts";
import { adminFormPost } from "#test-utils/session.ts";

describeWithEnv("server (attendee form) — tax save", { db: true }, () => {
  /** A booked attendee whose stored policy differs from the current Tax
   * settings, with the save's edit form. `withPreview` carries the current
   * preview token; without it the form is stale. */
  const taxSaveForm = async (email: string, withPreview: boolean) => {
    const { attendee } = await listingWithAttendee(5, "Before", email);
    await settings.update.tax({ mode: "add_to_total", rateBasisPoints: 2000 });
    const extra = withPreview
      ? { tax_preview: (await buildTaxSavePlan(attendee.id)).preview.token }
      : {};
    const form = await buildAttendeeEditForm(attendee.id, {
      extra,
      name: "After",
    });
    return { attendee, form };
  };

  /** Assert the save refused the stale preview and re-rendered the form. */
  const expectTaxConflict = async (response: Response): Promise<void> => {
    expect(response.status).toBe(200);
    assertStringIncludes(
      await response.text(),
      "The tax or money record changed",
    );
  };

  test("saves an edited attendee and renames it", async () => {
    const { attendee } = await listingWithAttendee(5, "Before", "b@e.com");
    const form = await buildAttendeeEditForm(attendee.id, { name: "After" });
    const { response } = await adminFormPost(
      `/admin/attendees/${attendee.id}`,
      form,
    );
    expect(response.status).toBe(302);
    const stored = await getAttendeeOrNull(
      attendee.id,
      await getTestPrivateKey(),
    );
    expect(stored!.name).toBe("After");
  });

  test("demands a fresh tax preview when the tax setting changed", async () => {
    const { attendee, form } = await taxSaveForm("stale@e.com", false);
    const { response } = await adminFormPost(
      `/admin/attendees/${attendee.id}`,
      form,
    );
    await expectTaxConflict(response);
  });

  test("keeps the save when the assessment changed under the save", async () => {
    const { attendee, form } = await taxSaveForm("conflict@e.com", true);
    await withDbFault(
      // The guard abort surfaces as a NOT NULL constraint failure naming the
      // assessment's group column — the one shape the save path recovers.
      sql`CREATE TRIGGER tax_assessment_fault BEFORE INSERT ON booking_tax_assessments WHEN NEW.revision > 0 BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: booking_tax_assessments.booking_group'); END`,
      "tax_assessment_fault",
      async () => {
        const { response } = await adminFormPost(
          `/admin/attendees/${attendee.id}`,
          form,
        );
        await expectTaxConflict(response);
      },
    );
    expect(
      (await readTaxAssessments([attendee.id])).map(
        (row) => row.state.revision,
      ),
    ).toEqual([0]);
  });

  test("saves through the changed-tax preview and raises the revision", async () => {
    const { attendee, form } = await taxSaveForm("taxed@e.com", true);
    const { response } = await adminFormPost(
      `/admin/attendees/${attendee.id}`,
      form,
    );
    expect(response.status).toBe(302);
    expect(
      (await readTaxAssessments([attendee.id])).map(
        (row) => row.state.revision,
      ),
    ).toEqual([0, 1]);
  });

  test("reports a save that keeps no line", async () => {
    const { attendee } = await listingWithAttendee(
      5,
      "Before",
      "nolines@e.com",
    );
    const statuses = await attendeeStatuses.getAll();
    const form = await buildAttendeeEditForm(attendee.id, {
      extra: { status_id: String(statuses[0]!.id) },
      lines: [],
      name: "After",
    });
    const { response } = await adminFormPost(
      `/admin/attendees/${attendee.id}`,
      form,
    );
    await expectHtmlResponse(
      response,
      200,
      "Book at least one listing before saving",
    );
  });

  test("rethrows a save failure that is not a tax assessment conflict", async () => {
    const { attendee, form } = await taxSaveForm("boom@e.com", true);
    await withDbFault(
      sql`CREATE TRIGGER tax_assessment_fault BEFORE INSERT ON booking_tax_assessments WHEN NEW.revision > 0 BEGIN SELECT RAISE(ABORT, 'tax assessment unavailable'); END`,
      "tax_assessment_fault",
      async () => {
        await expect(
          adminFormPost(`/admin/attendees/${attendee.id}`, form),
        ).rejects.toThrow("tax assessment unavailable");
      },
    );
  });
});
