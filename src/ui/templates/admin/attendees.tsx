/**
 * Admin attendee page templates
 */

/* jscpd:ignore-start */
import { compact } from "#fp";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateRangeLabel, formatDatetimeShort } from "#shared/dates.ts";
import type { ListingAttendeeRow } from "#shared/db/attendee-types.ts";
import type {
  QuestionWithAnswers,
  SelectedQuestionAnswers,
} from "#shared/db/question-types.ts";
import { Flash } from "#shared/forms/flash.tsx";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  bookingConflictLabel,
  bookingKey,
  hasBookingConflicts,
  nonConflictAnswerLabel,
} from "#shared/merge/attendee-merge.ts";
import type {
  AttendeeMergeDiff,
  AttendeeMergeDiffAnswerItem,
  AttendeeMergeDiffBookingItem,
  AttendeeMergeDiffPiiField,
} from "#shared/merge/attendee-merge-types.ts";
import { paymentDashboardUrl } from "#shared/payment-dashboard.ts";
import {
  defineTable,
  type TableColumn,
  type TableDefinition,
} from "#shared/tables/definition.ts";
import type {
  AdminSession,
  Attendee,
  ListingWithCount,
} from "#shared/types.ts";
import { ConfirmPage } from "#templates/admin/confirm-page.tsx";
import { SubmitButton } from "#templates/components/actions.tsx";
import {
  CheckboxLabel,
  SectionFieldset,
} from "#templates/components/aggregate-sections.tsx";
import { Badge } from "#templates/components/badge.tsx";
import {
  type LabelledLine,
  LabelledParas,
} from "#templates/components/labelled-para.tsx";
import { PageBlock } from "#templates/components/page-structure.tsx";
import { ProseSection } from "#templates/components/prose-section.tsx";
import { questionControl } from "#templates/components/question-controls.tsx";
import {
  RadioOption,
  type RadioOptionProps,
} from "#templates/components/radio-option.tsx";
import { SaveForm } from "#templates/components/save-form.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";

/* jscpd:ignore-end */

/** One labelled radio option used by each merge-decision table. */
const MergeRadioOption = ({
  children,
  ...option
}: RadioOptionProps): JSX.Element => (
  <RadioOption {...option}> {children}</RadioOption>
);

/** A merge-decision table with an optional legend-led form section. */
const DecisionTable = <TRow,>({
  heading,
  rows,
  table,
}: {
  heading?: string;
  rows: readonly TRow[];
  table: TableDefinition<TRow>;
}): JSX.Element => {
  const content = renderTable(table, rows);
  return heading ? (
    <SectionFieldset className="listing-section" legend={heading}>
      {content}
    </SectionFieldset>
  ) : (
    <div>{content}</div>
  );
};

/** The "Amount paid: £X" paragraph, rendered when the attendee paid > 0. */
const amountPaidPara = (attendee: Attendee): JSX.Element | null =>
  Number.parseInt(attendee.price_paid, 10) > 0 ? (
    <p>
      <strong>{t("admin.attendees.amount_paid")}</strong>{" "}
      {formatCurrency(attendee.price_paid)}
    </p>
  ) : null;

/**
 * The prose "attendee details" block shared by the delete/refund/resend
 * confirmation pages: name, email, quantity, (optionally) amount paid,
 * registered timestamp, then any page-specific trailing children.
 */
const AttendeeDetails = ({
  attendee,
  showAmountPaid,
  children,
}: {
  attendee: Attendee;
  showAmountPaid?: boolean;
  children?: Child;
}): JSX.Element => {
  // Only shown when the caller asked for it and the person actually paid,
  // matching the old `showAmountPaid && amountPaidPara(...)` guard.
  const amountPaidLine: LabelledLine | null =
    showAmountPaid && Number.parseInt(attendee.price_paid, 10) > 0
      ? {
          label: t("admin.attendees.amount_paid"),
          value: formatCurrency(attendee.price_paid),
        }
      : null;
  return (
    <ProseSection title={t("admin.attendees.details")}>
      <LabelledParas
        items={compact([
          { label: t("admin.attendees.name"), value: attendee.name },
          { label: t("admin.attendees.email"), value: attendee.email },
          { label: t("admin.attendees.quantity"), value: attendee.quantity },
          amountPaidLine,
          {
            label: t("admin.attendees.registered"),
            value: formatDatetimeShort(attendee.created),
          },
        ])}
      />
      {children}
    </ProseSection>
  );
};

/** Shared ConfirmPage shell for the delete/refund/resend attendee action
 *  pages: all three wrap an {@link AttendeeDetails} body in a ConfirmPage with
 *  the same active/label/name/returnUrl/warning structure. Only the action,
 *  title, button text, confirm message, and body children differ — those are
 *  passed via the config. The `warning` paragraph wraps a `<strong>` prefix
 *  (e.g. "Warning:") followed by the caller's text. */
/** Config object passed to {@link attendeeConfirmPage} (and built by
 *  {@link attendeeRouteConfirm}). The caller supplies everything except the
 *  `action` URL — the route factory injects that from its `segment` arg. */
type AttendeeConfirmConfig = {
  action: string;
  body?: JSX.Element;
  buttonText: string;
  confirmKey: string;
  danger?: boolean;
  showAmountPaid?: boolean;
  titleAction: string;
  warningPrefix: string;
  warningText: string;
};

const attendeeConfirmPage = (
  attendee: Attendee,
  session: AdminSession,
  error: string | undefined,
  returnUrl: string | undefined,
  config: AttendeeConfirmConfig,
): string =>
  ConfirmPage({
    action: config.action,
    active: "/admin/",
    buttonText: config.buttonText,
    children: (
      <AttendeeDetails
        attendee={attendee}
        {...(config.showAmountPaid ? { showAmountPaid: true } : {})}
      >
        <p>{t(config.confirmKey, { name: attendee.name })}</p>
        {config.body}
      </AttendeeDetails>
    ),
    danger: config.danger,
    error,
    label: t("admin.attendees.delete_label"),
    name: attendee.name,
    returnUrl,
    session,
    title: `${config.titleAction}: ${attendee.name}`,
    warning: (
      <p>
        <strong>{config.warningPrefix}:</strong> {config.warningText}
      </p>
    ),
  });
/** Build an attendee confirm-page renderer for a single action — the three
 *  admin delete/refund/resend pages share this signature, differing only in
 *  the route `segment` and the {@link attendeeConfirmPage} config. The
 *  wrapping `({ attendee }: {...}, session, returnUrl?, error?) => attendeeConfirmPage(...)`
 *  boilerplate was duplicated enough to trip jscpd; this factory keeps it in
 *  one place. */
const attendeeRouteConfirm =
  (segment: string, config: Omit<AttendeeConfirmConfig, "action">) =>
  (
    { attendee }: { listing: ListingWithCount; attendee: Attendee },
    session: AdminSession,
    returnUrl?: string,
    error?: string,
  ): string =>
    attendeeConfirmPage(attendee, session, error, returnUrl, {
      ...config,
      action: `/admin/attendees/${attendee.id}/${segment}`,
    });

/**
 * Admin delete attendee confirmation page
 */
export const adminDeleteAttendeePage = attendeeRouteConfirm("delete", {
  body: (
    <>
      <CheckboxLabel
        checked={true}
        label={` ${t("admin.attendees.release_bookings")}`}
        name="release_bookings"
        value="1"
      />
      <p>
        <small>{t("admin.attendees.release_bookings_note")}</small>
      </p>
    </>
  ),
  buttonText: t("admin.attendees.delete_submit"),
  confirmKey: "admin.attendees.delete_confirm",
  titleAction: "Delete Attendee",
  warningPrefix: "Warning",
  warningText:
    "This will permanently remove this attendee from the listing and delete any associated payment records.",
});

/**
 * Admin refund attendee confirmation page
 */
export const adminRefundAttendeePage = attendeeRouteConfirm("refund", {
  buttonText: t("admin.attendees.refund_submit"),
  confirmKey: "admin.attendees.refund_confirm",
  showAmountPaid: true,
  titleAction: "Refund Attendee",
  warningPrefix: "Warning",
  warningText:
    "This will issue a full refund for this attendee's payment. The attendee will remain registered.",
});

/**
 * Admin re-send notification confirmation page
 */
export const adminResendNotificationPage = attendeeRouteConfirm(
  "resend-notification",
  {
    buttonText: t("admin.attendees.resend_submit"),
    confirmKey: "admin.attendees.resend_confirm",
    danger: false,
    showAmountPaid: true,
    titleAction: "Re-send Notification",
    warningPrefix: "Note",
    warningText:
      "This will re-send the registration notification for this attendee.",
  },
);

/**
 * Admin refund all attendees confirmation page
 */
export const adminRefundAllAttendeesPage = (
  listing: ListingWithCount,
  refundableCount: number,
  session: AdminSession,
  error?: string,
): string =>
  ConfirmPage({
    action: `/admin/listing/${listing.id}/refund-all`,
    active: "/admin/",
    buttonText: t("admin.attendees.refund_all_submit"),
    children: (
      <p>{t("admin.attendees.refund_all_confirm", { name: listing.name })}</p>
    ),
    error,
    label: t("admin.attendees.refund_all_label"),
    name: listing.name,
    session,
    title: `Refund All: ${listing.name}`,
    warning: (
      <p>
        <Raw
          html={t("admin.attendees.refund_all_warning", {
            count: refundableCount,
          })}
        />
      </p>
    ),
  });

/** Render payment details section (read-only). Shared by the unified
 * add/edit attendee form. */
export const PaymentDetails = ({
  attendee,
  showBalanceLink,
}: {
  attendee: Attendee;
  /** The balance link targets the owner-only Ledger tab, so callers gate it
   * on the viewer's role (never render a forbidden link). */
  showBalanceLink: boolean;
}): JSX.Element | null => {
  if (!attendee.payment_id) return null;
  const isRefunded = attendee.refunded;
  const dashboardUrl = paymentDashboardUrl(attendee.payment_id);

  return (
    <PageBlock>
      <div class="prose">
        <h3>{t("admin.attendees.payment_details")}</h3>
        <p>
          <strong>{t("admin.attendees.payment_id")}</strong>{" "}
          {dashboardUrl ? (
            <a href={dashboardUrl} rel="noopener" target="_blank">
              {attendee.payment_id}
            </a>
          ) : (
            attendee.payment_id
          )}
        </p>
        {amountPaidPara(attendee)}
        <p>
          <strong>{t("admin.attendees.refund_status")}</strong>{" "}
          {isRefunded ? (
            <Badge variant="alert">{t("admin.attendees.refunded")}</Badge>
          ) : (
            t("admin.attendees.not_refunded")
          )}
        </p>
        {attendee.remaining_balance > 0 && (
          <p>
            <strong>Balance outstanding:</strong>{" "}
            {formatCurrency(attendee.remaining_balance)}
            {showBalanceLink && (
              <>
                {" — "}
                <a href={`/admin/attendees/${attendee.id}/ledger`}>
                  view ledger &amp; payment link
                </a>
              </>
            )}
          </p>
        )}
      </div>
      <SaveForm
        action={`/admin/attendees/${attendee.id}/refresh-payment`}
        class="inline"
        submitIcon="rotate-ccw"
        submitLabel={t("admin.attendees.refresh_payment")}
      />
    </PageBlock>
  );
};

/** Render custom question fields with pre-selected answers for admin edit.
 * Shared by the unified add/edit attendee form.
 *
 * Question text may contain markdown — simple text is used as a clickable
 * label; complex markdown is rendered as a prose block above the control. */
/** The answers to offer for a question in the admin edit form: every active
 *  answer plus any inactive one the attendee already has selected (so a
 *  previously chosen, now-deactivated answer is never silently dropped). */
const editableAnswers = (q: QuestionWithAnswers, selectedAnswerIds: number[]) =>
  q.answers.filter((a) => a.active || selectedAnswerIds.includes(a.id));

export const EditQuestions = ({
  questions,
  selectedAnswerIds,
  selectedTextAnswers,
}: SelectedQuestionAnswers): JSX.Element => (
  <>
    {questions.map((q) =>
      questionControl(q, {
        isChosen: (answerId) => selectedAnswerIds.includes(answerId),
        options: editableAnswers(q, selectedAnswerIds),
        placeholder: t("attendee_form.no_answer"),
        // A saved free-text answer may legitimately not exist yet.
        textValue: selectedTextAnswers.get(q.id) ?? "",
      }),
    )}
  </>
);

/** Source attendee data for the merge preview page */
type MergeSourceInfo = {
  id: number;
  name: string;
  email: string;
  phone: string;
  address: string;
  special_instructions: string;
  ticket_token: string;
  bookings: ListingAttendeeRow[];
};

/** Render a value as either plain text or a preformatted span */
const renderFieldValue = (value: string, multiline: boolean): string =>
  multiline
    ? String(<span style="white-space:pre-wrap">{value || "—"}</span>)
    : value || "—";

/** The PII field choices for the current and source attendee. */
const MergePiiDecisionTable = ({
  fields,
  sourceName,
  targetName,
}: {
  fields: AttendeeMergeDiffPiiField[];
  sourceName: string;
  targetName: string;
}): JSX.Element => (
  <DecisionTable
    heading=""
    rows={fields}
    table={defineTable<AttendeeMergeDiffPiiField>([
      {
        cell: (field) => field.label,
        header: () => t("admin.attendees.field"),
        key: "field",
      },
      {
        cell: (field) => (
          <MergeRadioOption
            checked={true}
            name={`pii_${field.field}`}
            value="target"
          >
            <Raw html={renderFieldValue(field.targetValue, field.multiline)} />
          </MergeRadioOption>
        ),
        header: (
          <>
            {"Keep (current): "}
            <strong>{targetName}</strong>
          </>
        ),
        key: "target",
      },
      {
        cell: (field) =>
          field.same ? (
            <span class="muted">(same)</span>
          ) : (
            <MergeRadioOption
              checked={false}
              name={`pii_${field.field}`}
              value="source"
            >
              <Raw
                html={renderFieldValue(field.sourceValue, field.multiline)}
              />
            </MergeRadioOption>
          ),
        header: (
          <>
            {"Take from: "}
            <strong>{sourceName}</strong>
          </>
        ),
        key: "source",
      },
    ])}
  />
);

const mergeAnswerColumns = (
  targetName: string,
  sourceName: string,
): TableColumn<AttendeeMergeDiffAnswerItem>[] => {
  const choiceColumn = (
    key: "source" | "clear",
    header: Child,
    label: (item: AttendeeMergeDiffAnswerItem) => Child,
  ): TableColumn<AttendeeMergeDiffAnswerItem> => ({
    cell: (item) =>
      item.conflict ? (
        <MergeRadioOption
          checked={false}
          name={`answer_${item.questionId}`}
          value={key}
        >
          {label(item)}
        </MergeRadioOption>
      ) : null,
    header,
    key,
  });
  return [
    {
      cell: (item) => item.questionText,
      header: () => t("terms.question"),
      key: "question",
    },
    {
      cell: (item) => {
        if (!item.conflict) {
          const { answer, from } = nonConflictAnswerLabel(item);
          return (
            <span class="muted">
              {answer} ({from} — auto-kept)
            </span>
          );
        }
        return (
          <MergeRadioOption
            checked={true}
            name={`answer_${item.questionId}`}
            value="target"
          >
            {item.targetAnswerText!}
          </MergeRadioOption>
        );
      },
      header: `Keep (${targetName})`,
      key: "target",
    },
    choiceColumn(
      "source",
      `Take from (${sourceName})`,
      (item) => item.sourceAnswerText!,
    ),
    choiceColumn("clear", t("admin.attendees.th_clear"), () => "None"),
  ];
};

/** Render the answer decision table. */
const MergeAnswersDecisionTable = ({
  diff,
  targetName,
  sourceName,
}: {
  diff: AttendeeMergeDiff;
  targetName: string;
  sourceName: string;
}): JSX.Element | null => {
  if (diff.answerItems.length === 0) return null;
  return (
    <DecisionTable
      heading={t("admin.attendees.custom_question_answers")}
      rows={diff.answerItems}
      table={defineTable(mergeAnswerColumns(targetName, sourceName))}
    />
  );
};

/** A not-checked radio option preceded by a line break — the shape each choice
 *  after the first in the booking-conflict decision (and its money follow-up)
 *  takes, so the `<br/>` + radio pairing lives in one place. */
const BreakRadio = ({
  name,
  value,
  children,
}: {
  name: string;
  value: string;
  children: Child;
}): JSX.Element => (
  <>
    <br />
    <RadioOption checked={false} name={name} value={value}>
      {" "}
      {children}
    </RadioOption>
  </>
);

const bookingDateLabel = (item: AttendeeMergeDiffBookingItem): string =>
  item.startAt
    ? formatDateRangeLabel(item.startAt, item.sourceBooking.end_at)
    : "—";

const bookingDecisionName = (item: AttendeeMergeDiffBookingItem): string =>
  bookingKey(
    item.listingId,
    item.startAt,
    item.parentListingId,
    item.packageGroupId,
  );

const bookingStatus = (item: AttendeeMergeDiffBookingItem): JSX.Element => {
  if (item.conflictClass === "moveable") {
    return <span class="muted">Will be moved</span>;
  }
  const conflictLabel = bookingConflictLabel(item);
  const targetQty = item.targetBooking!.quantity;
  return (
    <>
      <strong>{conflictLabel}</strong>
      {item.targetBooking &&
        ` (target qty: ${targetQty}, source qty: ${item.sourceBooking.quantity})`}
    </>
  );
};

const BookingChoice = ({
  item,
}: {
  item: AttendeeMergeDiffBookingItem;
}): JSX.Element | null => {
  if (item.conflictClass === "moveable") return null;
  const key = bookingDecisionName(item);
  const name = `booking_${key}`;
  const moneyAtStake = Math.max(item.sourceSaleAmount, item.targetSaleAmount);
  return (
    <>
      <RadioOption checked name={name} value="keep_target">
        {" "}
        Keep target
      </RadioOption>
      <BreakRadio name={name} value="take_source">
        Replace with source
      </BreakRadio>
      <BreakRadio name={name} value="skip_source">
        Skip source
      </BreakRadio>
      {moneyAtStake > 0 && (
        <div class="merge-money-decision">
          <p class="muted">
            <strong>{t("attendee_form.merge_discarded_payment_label")}</strong>{" "}
            (source {formatCurrency(item.sourceSaleAmount)}, target{" "}
            {formatCurrency(item.targetSaleAmount)}) — this can't be undone, so
            choose explicitly:
          </p>
          <RadioOption checked={false} name={`money_${key}`} value="credit">
            {" "}
            Keep as the person's credit
          </RadioOption>
          <BreakRadio name={`money_${key}`} value="writeoff">
            Write it off
          </BreakRadio>
        </div>
      )}
    </>
  );
};

const bookingColumns = (
  hasConflicts: boolean,
): TableColumn<AttendeeMergeDiffBookingItem>[] => [
  translatedTableColumn(
    "listing",
    "terms.listing",
    (item) => `Listing #${item.listingId}`,
  ),
  translatedTableColumn("date", "common.date", bookingDateLabel),
  translatedTableColumn(
    "quantity",
    "admin.attendees.source_qty",
    (item) => item.sourceBooking.quantity,
  ),
  translatedTableColumn("status", "common.status", bookingStatus),
  ...(hasConflicts
    ? [
        translatedTableColumn(
          "decision",
          "admin.attendees.decision",
          (item: AttendeeMergeDiffBookingItem) => <BookingChoice item={item} />,
        ),
      ]
    : []),
];

/** Render the booking decision table. */
const MergeBookingsDecisionTable = ({
  diff,
}: {
  diff: AttendeeMergeDiff;
}): JSX.Element => {
  const hasConflicts = hasBookingConflicts(diff.bookingItems);
  return (
    <DecisionTable
      heading={t("admin.attendees.listing_registrations")}
      rows={diff.bookingItems}
      table={defineTable(bookingColumns(hasConflicts))}
    />
  );
};

const MergeNamedDecisionTables = ({
  diff,
  sourceName,
  targetName,
}: {
  diff: AttendeeMergeDiff;
  sourceName: string;
  targetName: string;
}): JSX.Element => (
  <>
    <MergePiiDecisionTable
      fields={diff.piiFields}
      sourceName={sourceName}
      targetName={targetName}
    />
    <MergeAnswersDecisionTable
      diff={diff}
      sourceName={sourceName}
      targetName={targetName}
    />
  </>
);

/**
 * Attendee merge panel (the Actions tab) — search for a source attendee by
 * ticket token, then choose what to keep and confirm the merge.
 */
export const AttendeeMergePanel = (
  target: Attendee,
  source: MergeSourceInfo | null,
  searchToken: string | null,
  error?: string,
  mergeDiff?: AttendeeMergeDiff,
): JSX.Element => (
  <article>
    <Flash error={error} />

    <h3>{t("admin.attendees.merge_attendee")}</h3>

    {/* Token search form — GETs back to this tab with ?token=… */}
    <h4>{t("admin.attendees.search_by_token")}</h4>
    <form
      action={`/admin/attendees/${target.id}/actions`}
      class="inline-row"
      method="get"
    >
      <label for="token">
        Ticket token to merge from
        <input
          autofocus={!source}
          id="token"
          name="token"
          placeholder={t("attendee_form.enter_ticket_token_placeholder")}
          required
          type="text"
          value={searchToken || ""}
        />
      </label>
      <SubmitButton icon="search">
        {t("attendee_form.search_button")}
      </SubmitButton>
    </form>

    {source && mergeDiff && (
      <div>
        <div class="prose">
          <h3>{t("admin.attendees.merge_preview")}</h3>
          <p>
            Choose which value to keep for each field. Resolve any conflicts
            below. The source attendee will then be deleted.
          </p>
        </div>

        <SaveForm
          action={`/admin/attendees/${target.id}/merge`}
          submitClass="danger"
          submitIcon="trash-2"
          submitLabel="Merge and Delete Source Attendee"
        >
          <input
            name="source_token"
            type="hidden"
            value={source.ticket_token}
          />
          <input name="merge_version" type="hidden" value={mergeDiff.version} />

          <MergeNamedDecisionTables
            diff={mergeDiff}
            sourceName={source.name}
            targetName={target.name}
          />

          {/* Booking decisions */}
          <MergeBookingsDecisionTable diff={mergeDiff} />

          <p>
            <strong>Warning:</strong> This will permanently delete the source
            attendee. This action cannot be undone.
          </p>
        </SaveForm>
      </div>
    )}
  </article>
);
