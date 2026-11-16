import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { insertRow } from "#db/record-table.ts";
import { tables } from "#db/select/tables.ts";
import {
  buildCreateForm,
  buildTemplateData,
  loadPackagePaths,
} from "#routes/admin/attendee-page-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

const blankForm = () => buildCreateForm([], [], new Map(), "");

/** The error fields every create form's template data carries. */
const ERROR_FIELDS = ["attendeeError", "dateError", "formError"] as const;

/** The create form's template data for a blank form booked on `status` — the
 * shape the no-order balance tests read. */
const dataForStatus = async (status: { id: number }) => {
  const parsed = blankForm();
  parsed.statusId = status.id;
  return buildTemplateData("create", parsed, null);
};

describeWithEnv("attendee form template data", { db: true }, () => {
  test("the package editor still offers an inactive member's path", async () => {
    const group = await createTestGroup({
      isPackage: true,
      name: "Dormant Package",
    });
    const stall = await createTestListing({
      groupId: group.id,
      name: "Dormant Stall",
    });
    await deactivateTestListing(stall.id);

    const paths = await loadPackagePaths();
    const path = paths.find((candidate) => candidate.groupId === group.id);
    expect(path?.memberListingIds).toEqual([stall.id]);
  });

  test("preserves explicit empty errors and uses the default display values", async () => {
    const data = await buildTemplateData("create", blankForm(), null, {
      attendeeError: "",
      dateError: "",
      formError: "",
    });

    for (const errorField of ERROR_FIELDS) {
      expect(data[errorField]).toBe("");
    }
    expect(data.hasMixedTimings).toBe(false);
    expect(data.questions).toEqual([]);
    expect(data.selectedAnswerIds).toEqual([]);
    expect(data.selectedTextAnswers).toEqual(new Map());
  });

  test("a new reservation with no order does not show an unpaid-balance warning", async () => {
    const status = await insertRow(tables.attendee_statuses, {
      is_reservation: true,
      name: "New reservation",
      reservation_amount: "25%",
    });

    expect((await dataForStatus(status)).balanceNotice).toBeNull();
  });

  test("a new paid attendee with no order does not show an owing warning", async () => {
    const status = await insertRow(tables.attendee_statuses, {
      is_paid_default: true,
      name: "Paid before booking",
    });

    expect((await dataForStatus(status)).balanceNotice).toBeNull();
  });

  test("loads a stored parent name for an add-on booking path", async () => {
    const parent = await createTestListing({ name: "Named parent" });
    const child = await createTestListing({ name: "Named child" });
    const parsed = buildCreateForm(
      [testListingWithCount(child)],
      [],
      new Map([[child.id, 1]]),
      "",
    );
    parsed.lines[0]!.parentListingId = parent.id;

    const data = await buildTemplateData("create", parsed, null);

    expect(data.parentNamesById).toEqual(new Map([[parent.id, parent.name]]));
  });
});
