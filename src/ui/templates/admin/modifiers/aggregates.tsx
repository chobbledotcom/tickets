/**
 * The modifier aggregate totals: the running-totals section shown on the edit
 * page and the standalone recalculate page that compares stored totals with
 * totals recounted from attendee records.
 */

import { t } from "#i18n";
import type {
  ModifierAggregateField,
  ModifierAggregateRecalculation,
} from "#shared/db/modifiers.ts";
import type { AdminSession, Modifier } from "#shared/types.ts";
import type { RecalculateRow } from "#templates/admin/recalculate.tsx";
import {
  type RunningTotalsConfig,
  RunningTotalsFieldset,
  recalculatePageRenderer,
} from "#templates/components/aggregate-sections.tsx";
import { modifierAggregateFields } from "#templates/fields/aggregate.ts";
import { modifierAggregateToFieldValues } from "./values.ts";

const modifierRunningTotalsConfig = (
  modifier: Modifier,
): RunningTotalsConfig => ({
  fields: modifierAggregateFields,
  legend: t("modifiers.running_totals"),
  note: t("modifiers.running_totals_note"),
  recalculateHref: `/admin/modifiers/recalculate/${modifier.id}`,
  recalculateLabel: t("modifiers.recalculate_totals"),
  values: modifierAggregateToFieldValues(modifier),
});

/** The running-totals fieldset on the modifier edit page. */
export const ModifierRunningTotalsSection = ({
  modifier,
}: {
  modifier: Modifier;
}): JSX.Element =>
  RunningTotalsFieldset({
    config: modifierRunningTotalsConfig(modifier),
  });

const modifierAggregateFormatters: Record<
  ModifierAggregateField,
  (value: number) => string
> = {
  total_uses: String,
  usage_count: String,
};

const modifierRecalculateRows = (
  snapshot: ModifierAggregateRecalculation,
): RecalculateRow[] =>
  modifierAggregateFields.map((field) => {
    const name = field.name as ModifierAggregateField;
    return {
      current: modifierAggregateFormatters[name](snapshot[name].current),
      label: field.label,
      name,
      recalculated: modifierAggregateFormatters[name](
        snapshot[name].recalculated,
      ),
    };
  });

/** Renders the static config bits of the modifier recalculate page (action,
 *  labels, rows). The exported `adminModifierRecalculatePage` then binds the
 *  per-request `(session, error?, success?)` to it. */
const modifierRecalculateRenderer = (
  modifier: Modifier,
  snapshot: ModifierAggregateRecalculation,
) =>
  recalculatePageRenderer({
    action: `/admin/modifiers/recalculate/${modifier.id}`,
    active: { section: "/admin/modifiers" },
    currentLabel: t("modifiers.recalculate.current"),
    description: t("modifiers.recalculate.description"),
    recalculatedLabel: t("modifiers.recalculate.from_attendees"),
    rows: modifierRecalculateRows(snapshot),
    submitLabel: t("modifiers.recalculate.save"),
    title: t("modifiers.recalculate.heading", { name: modifier.name }),
  });

export const adminModifierRecalculatePage = (
  modifier: Modifier,
  snapshot: ModifierAggregateRecalculation,
  session: AdminSession,
  error?: string,
  success?: string,
): string =>
  modifierRecalculateRenderer(modifier, snapshot)(session, error, success);
