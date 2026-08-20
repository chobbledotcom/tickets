import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeStatuses } from "#db/attendee-statuses.ts";
import {
  buildCreateForm,
  buildTemplateData,
} from "#routes/admin/attendee-page-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const blankForm = () => buildCreateForm([], [], new Map(), "");

describeWithEnv("attendee form template data", { db: true }, () => {
  test("preserves explicit empty errors and uses the default display values", async () => {
    const data = await buildTemplateData("create", blankForm(), null, {
      attendeeError: "",
      dateError: "",
      formError: "",
    });

    expect(data.attendeeError).toBe("");
    expect(data.dateError).toBe("");
    expect(data.formError).toBe("");
    expect(data.hasMixedTimings).toBe(false);
    expect(data.questions).toEqual([]);
    expect(data.selectedAnswerIds).toEqual([]);
    expect(data.selectedTextAnswers).toEqual(new Map());
  });

  test("a new reservation with no order does not show an unpaid-balance warning", async () => {
    const status = await attendeeStatuses.table.insert({
      isReservation: true,
      name: "New reservation",
      reservationAmount: "25%",
    });
    const parsed = blankForm();
    parsed.statusId = status.id;

    const data = await buildTemplateData("create", parsed, null);

    expect(data.balanceNotice).toBeNull();
  });

  test("a new paid attendee with no order does not show an owing warning", async () => {
    const status = await attendeeStatuses.table.insert({
      isPaidDefault: true,
      name: "Paid before booking",
    });
    const parsed = blankForm();
    parsed.statusId = status.id;

    const data = await buildTemplateData("create", parsed, null);

    expect(data.balanceNotice).toBeNull();
  });
});
