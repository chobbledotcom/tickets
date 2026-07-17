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
import type { Modifier } from "#shared/types.ts";
import type { RecalculateRow } from "#templates/admin/recalculate.tsx";
import { buildRecalculateRows } from "#templates/admin/recalculate-rows.ts";
import {
  bindRecalculatePage,
  type RunningTotalsConfig,
  RunningTotalsFieldset,
  recalculatePageRenderer,
} from "#templates/components/aggregate-sections.tsx";
import { getModifierAggregateFields } from "#templates/fields/aggregate.ts";
import { modifierAggregateToFieldValues } from "./values.ts";

const modifierRunningTotalsConfig = (
  modifier: Modifier,
  values: Record<
    string,
    string | number | null
  > = modifierAggregateToFieldValues(modifier),
): RunningTotalsConfig => ({
  fields: getModifierAggregateFields(),
  legend: t("modifiers.running_totals"),
  note: t("modifiers.running_totals_note"),
  recalculateHref: `/admin/modifiers/recalculate/${modifier.id}`,
  recalculateLabel: t("modifiers.recalculate_totals"),
  values,
});

export type ModifierSectionProps = { modifier: Modifier };

/** The running-totals fieldset on the modifier edit page. */
export const ModifierRunningTotalsSection = (
  props: ModifierSectionProps & {
    values?: Record<string, string | number | null>;
  },
): JSX.Element =>
  RunningTotalsFieldset({
    config: modifierRunningTotalsConfig(props.modifier, props.values),
  });

const modifierAggregateFormatters: Record<
  ModifierAggregateField,
  (value: number) => string
> = {
  total_uses: String,
  usage_count: String,
};

const formatModifierAggregateValue = (
  name: ModifierAggregateField,
  value: number,
): string => modifierAggregateFormatters[name](value);

const modifierRecalculateRows = (
  snapshot: ModifierAggregateRecalculation,
): RecalculateRow[] =>
  buildRecalculateRows(
    getModifierAggregateFields(),
    formatModifierAggregateValue,
    snapshot,
  );

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

export const adminModifierRecalculatePage = bindRecalculatePage(
  modifierRecalculateRenderer,
);
