/** The warnings box above the attendee page tabs. It looks like a system note
 * but has no "×": a warning goes away only when the booking changes. */

import { t } from "#i18n";
import type { LineAnswerRow } from "#routes/admin/attendee-line-answers.ts";
import type {
  AttendeePageWarnings,
  AttendeeWarning,
  WarningsByAttendee,
} from "#routes/admin/attendee-warnings.ts";
import { AttendeeAlertsSummary } from "#templates/admin/attendee-notes.tsx";
import { WritableOnly } from "#templates/admin/writable-only.tsx";

/** What the page knows besides the warning itself. */
type WarningPage = {
  attendeeId: number;
  hiddenAnswers: readonly LineAnswerRow[];
};

type WarningOf<Kind extends AttendeeWarning["kind"]> = Extract<
  AttendeeWarning,
  { kind: Kind }
>;

/** One entry for each kind, which takes a warning of its own kind. */
type ByKind<Result, Extra extends unknown[] = []> = {
  [Kind in AttendeeWarning["kind"]]: (
    warning: WarningOf<Kind>,
    ...extra: Extra
  ) => Result;
};

/** The words of one warning. */
const WARNING_MESSAGES: ByKind<string> = {
  hidden_answers: ({ count }) =>
    t("attendee_warnings.hidden_answers", { count }),
  parent_without_child: ({ children, parent }) =>
    t("attendee_warnings.parent_without_child", {
      children: children.join(", "),
      parent,
    }),
  plan_without_site: ({ listings }) =>
    t("attendee_warnings.plan_without_site", { listings: listings.join(", ") }),
};

/** Each hidden answer: what it answers, and the answer. */
export const HiddenAnswerList = ({
  answers,
}: {
  answers: readonly LineAnswerRow[];
}): JSX.Element => (
  <ul>
    {answers.map(({ answer, name }) => (
      <li>
        <strong>{name}</strong> {answer}
      </li>
    ))}
  </ul>
);

/** What the attendee page shows under the words of one warning. */
const WARNING_DETAILS: ByKind<JSX.Element | null, [page: WarningPage]> = {
  hidden_answers: (_warning, { attendeeId, hiddenAnswers }) => (
    <>
      <HiddenAnswerList answers={hiddenAnswers} />
      <WritableOnly>
        <p>
          <a href={`/admin/attendees/${attendeeId}/delete-hidden-answers`}>
            {t("attendee_warnings.delete_hidden_answers")}
          </a>
        </p>
      </WritableOnly>
    </>
  ),
  parent_without_child: () => null,
  plan_without_site: () => null,
};

// The tables are exhaustive over the kinds, so each entry takes its own kind.
const messageOf = (warning: AttendeeWarning): string =>
  WARNING_MESSAGES[warning.kind](warning as never);

const detailOf = (
  warning: AttendeeWarning,
  page: WarningPage,
): JSX.Element | null => WARNING_DETAILS[warning.kind](warning as never, page);

/** One alert for each warning. Renders nothing when there are none. */
export const AttendeeWarningsBox = ({
  attendeeId,
  hiddenAnswers,
  warnings,
}: AttendeePageWarnings & { attendeeId: number }): JSX.Element | null =>
  warnings.length === 0 ? null : (
    <section class="attendee-warnings">
      {warnings.map((warning) => (
        <div class="system-note system-note-alert" role="alert">
          <span class="system-note-tag">{t("attendee_warnings.tag")}</span>
          <p>{messageOf(warning)}</p>
          {detailOf(warning, { attendeeId, hiddenAnswers })}
        </div>
      ))}
    </section>
  );

/** The warnings summary above an attendee list: each listed attendee with
 * warnings, and the words of each warning. */
export const AttendeeWarningsSummary = ({
  names,
  warnings,
}: {
  names: Map<number, string>;
  warnings: WarningsByAttendee;
}): JSX.Element | null =>
  AttendeeAlertsSummary({
    alerts: warnings,
    names,
    render: (warning: AttendeeWarning) => (
      <div class="system-note">{messageOf(warning)}</div>
    ),
    summary: (count) => t("attendee_warnings.summary", { count }),
  });
