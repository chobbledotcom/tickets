/** The page that deletes the answers no booked ticket shows. */

import { t } from "#i18n";
import type { LineAnswerRow } from "#routes/admin/attendee-line-answers.ts";
import { HiddenAnswerList } from "#templates/admin/attendee-warnings.tsx";
import { attendeeRouteConfirm } from "#templates/admin/attendees.tsx";
import type { Attendee } from "#types";

const hiddenAnswersConfirm = {
  buttonText: t("attendee_warnings.delete_submit"),
  confirmKey: "attendee_warnings.delete_confirm",
  titleAction: t("attendee_warnings.delete_title"),
  warningPrefix: t("attendee_warnings.tag"),
  warningText: t("attendee_warnings.delete_warning"),
};

/** The answers to delete, and the form that names them. The form sends the
 * answers that the operator saw, so the delete never takes another one. */
export const adminHiddenAnswersPage = attendeeRouteConfirm<{
  attendee: Attendee;
  hiddenAnswers: LineAnswerRow[];
}>("delete-hidden-answers", hiddenAnswersConfirm, ({ hiddenAnswers }) => ({
  body: <HiddenAnswerList answers={hiddenAnswers} />,
  hiddenFields: {
    answer_ids: hiddenAnswers.map(({ id }) => id).join(","),
  },
}));

/** Say that there is nothing to delete, without a form. */
export const adminNoHiddenAnswersPage = attendeeRouteConfirm(
  "delete-hidden-answers",
  { ...hiddenAnswersConfirm, disabled: true },
);
