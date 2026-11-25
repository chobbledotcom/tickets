/** The delete of the answers that no booked ticket shows. The page names the
 * answers that the operator saw, and the delete takes only those that are
 * still hidden. */

import { logActivity } from "#db/activity-log.ts";
import { deleteHiddenLineAnswers } from "#db/questions/attendee-answers/hidden.ts";
import { t } from "#i18n";
import { defineAdminRoutes } from "#routes/admin/route-tables.ts";
import { adminRedirect, errorRedirect } from "#routes/response.ts";
import type { FormParams } from "#shared/form-data.ts";
import { isPositiveSafeInteger } from "#shared/validation/number.ts";
import {
  adminHiddenAnswersPage,
  adminNoHiddenAnswersPage,
} from "#templates/admin/attendees/hidden-answers-confirm.tsx";
import {
  attendeeActions,
  attendeeActionUrlWithReturn,
} from "./attendees-route-helpers.ts";

const ACTION = "delete-hidden-answers";

const PATTERN = "/admin/attendees/:attendeeId/delete-hidden-answers";

/** The answer ids that the page sent, or null when they are not a list of
 * ids. */
const answerIdsOrNull = (form: FormParams): number[] | null => {
  const ids = form.getString("answer_ids").split(",").map(Number);
  return ids.every(isPositiveSafeInteger) ? ids : null;
};

const handleHiddenAnswersGet = attendeeActions[ACTION].page(
  PATTERN,
  ({ hiddenAnswers }) =>
    hiddenAnswers.length === 0
      ? {
          reason: t("attendee_warnings.no_hidden_answers"),
          render: adminNoHiddenAnswersPage,
        }
      : { reason: null, render: adminHiddenAnswersPage },
);

const handleHiddenAnswersPost = attendeeActions[ACTION].verified(
  PATTERN,
  undefined,
  async ({ attendee }, form) => {
    const answerIds = answerIdsOrNull(form);
    if (answerIds === null) {
      return errorRedirect(
        attendeeActionUrlWithReturn(
          attendee.id,
          ACTION,
          form.getString("returnUrl"),
        ),
        t("attendee_warnings.answer_ids_invalid"),
      );
    }
    await deleteHiddenLineAnswers(attendee.id, answerIds);
    await logActivity(
      `Hidden answers deleted for '${attendee.name}'`,
      null,
      attendee.id,
    );
    return adminRedirect(
      "attendee",
      { attendeeId: attendee.id },
      t("attendee_warnings.hidden_answers_deleted"),
      true,
      { form },
    );
  },
);

export const hiddenAnswerHandlers = defineAdminRoutes({
  "GET /admin/attendees/:attendeeId/delete-hidden-answers":
    handleHiddenAnswersGet,
  "POST /admin/attendees/:attendeeId/delete-hidden-answers":
    handleHiddenAnswersPost,
});
