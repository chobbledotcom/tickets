/* jscpd:ignore-start */
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { formatDateRangeLabel } from "#shared/dates.ts";
import type { Child } from "#shared/jsx/jsx-runtime.ts";
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
import type { TableColumn } from "#shared/tables/column.ts";
import {
  defineTable,
  type TableDefinition,
} from "#shared/tables/definition.ts";
import { SectionFieldset } from "#templates/components/aggregate-sections.tsx";
import {
  RadioOption,
  type RadioOptionProps,
} from "#templates/components/radio-option.tsx";
import { renderTable } from "#templates/components/table.tsx";
import { translatedTableColumn } from "#templates/components/translated-table-column.ts";

/* jscpd:ignore-end */

const MergeRadioOption = ({
  children,
  ...option
}: RadioOptionProps): JSX.Element => (
  <RadioOption {...option}> {children}</RadioOption>
);

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

const renderFieldValue = (value: string, multiline: boolean): Child =>
  multiline ? (
    <span style="white-space:pre-wrap">{value || "—"}</span>
  ) : (
    value || "—"
  );

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
        rowHeader: true,
      },
      {
        cell: (field) => (
          <MergeRadioOption
            checked={true}
            name={`pii_${field.field}`}
            value="target"
          >
            {renderFieldValue(field.targetValue, field.multiline)}
          </MergeRadioOption>
        ),
        header: t("admin.attendees.merge_keep_current", { name: targetName }),
        key: "target",
      },
      {
        cell: (field) =>
          field.same ? (
            <span class="muted">{t("admin.attendees.merge_same")}</span>
          ) : (
            <MergeRadioOption
              checked={false}
              name={`pii_${field.field}`}
              value="source"
            >
              {renderFieldValue(field.sourceValue, field.multiline)}
            </MergeRadioOption>
          ),
        header: t("admin.attendees.merge_use_source", { name: sourceName }),
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
      rowHeader: true,
    },
    {
      cell: (item) => {
        if (!item.conflict) {
          const { answer, from } = nonConflictAnswerLabel(item);
          return (
            <span class="muted">
              {t("admin.attendees.merge_answer_kept", { answer, from })}
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
      header: t("admin.attendees.merge_keep_answer", { name: targetName }),
      key: "target",
    },
    choiceColumn(
      "source",
      t("admin.attendees.merge_use_answer", { name: sourceName }),
      (item) => item.sourceAnswerText!,
    ),
    choiceColumn("clear", t("admin.attendees.th_clear"), () =>
      t("admin.attendees.merge_no_answer"),
    ),
  ];
};

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
    return <span class="muted">{t("admin.attendees.merge_will_move")}</span>;
  }
  const conflictLabel = bookingConflictLabel(item);
  const targetQty = item.targetBooking!.quantity;
  return (
    <>
      <strong>{conflictLabel}</strong>
      {item.targetBooking &&
        ` ${t("admin.attendees.merge_booking_quantities", {
          source: item.sourceBooking.quantity,
          target: targetQty,
        })}`}
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
        {t("admin.attendees.merge_keep_booking")}
      </RadioOption>
      <BreakRadio name={name} value="take_source">
        {t("admin.attendees.merge_use_booking")}
      </BreakRadio>
      <BreakRadio name={name} value="skip_source">
        {t("admin.attendees.merge_skip_booking")}
      </BreakRadio>
      {moneyAtStake > 0 && (
        <div class="merge-money-decision">
          <p class="muted">
            <strong>{t("attendee_form.merge_discarded_payment_label")}</strong>{" "}
            {t("admin.attendees.merge_payment_choice", {
              current: formatCurrency(item.targetSaleAmount),
              source: formatCurrency(item.sourceSaleAmount),
            })}
          </p>
          <RadioOption checked={false} name={`money_${key}`} value="credit">
            {" "}
            {t("admin.attendees.merge_keep_credit")}
          </RadioOption>
          <BreakRadio name={`money_${key}`} value="writeoff">
            {t("admin.attendees.merge_write_off")}
          </BreakRadio>
        </div>
      )}
    </>
  );
};

const bookingColumns = (
  hasConflicts: boolean,
): TableColumn<AttendeeMergeDiffBookingItem>[] => [
  translatedTableColumn("listing", "terms.listing", (item) =>
    t("admin.attendees.merge_listing_number", { id: item.listingId }),
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

/** Render every choice needed to merge one attendee into another. */
export const MergeDecisionTables = ({
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
    <MergeBookingsDecisionTable diff={diff} />
  </>
);
