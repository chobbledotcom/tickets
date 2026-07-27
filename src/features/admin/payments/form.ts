import * as v from "valibot";
import { t } from "#i18n";
import {
  defineForm,
  type FormDefinition,
  type FormValuesFor,
} from "#shared/forms/definition.ts";
import type {
  ChoiceField,
  ChoiceOptions,
  InputField,
  TextareaField,
} from "#shared/forms/field.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import type { PaymentAccount } from "#shared/payment-runtime/account.ts";
import {
  type PaymentOperatorCase,
  paymentDecisionSelections,
} from "#shared/payment-runtime/operator-context.ts";
import type { PaymentOperatorSelection } from "#shared/payment-state/lifecycle.ts";
import { PaymentOperatorSelectionSchema } from "#shared/payment-state/lifecycle.ts";

type DecisionFields = readonly [
  ChoiceField<"select", string, "decision", "decision"> & {
    required: true;
    section: "decision";
  },
  TextareaField<"reason", "reason"> & {
    parse: (value: string) => string;
    required: true;
    section: "reason";
  },
  InputField<"case_revision", "decision"> & {
    parse: (value: string) => number;
    required: true;
    section: "decision";
  },
];

export type PaymentDecisionFormValues = FormValuesFor<DecisionFields>;
export type PaymentDecisionForm = FormDefinition<DecisionFields>;

export const paymentSelectionValue = (
  selection: PaymentOperatorSelection,
): string =>
  selection.kind === "assign_provider"
    ? [
        selection.kind,
        selection.provider,
        selection.mode,
        selection.accountId,
      ].join(":")
    : selection.kind;

const selectionLabel = (selection: PaymentOperatorSelection): string => {
  if (selection.kind === "assign_provider") {
    return t("admin.payments.decision.assign_provider", {
      account: selection.accountId,
      mode: t(`admin.payments.mode.${selection.mode}`),
      provider: PAYMENT_PROVIDERS[selection.provider].label,
    });
  }
  return t(`admin.payments.decision.${selection.kind}`);
};

const selectionHint = (selection: PaymentOperatorSelection): string =>
  t(`admin.payments.decision.${selection.kind}_hint`);

const decisionOptions = (
  context: PaymentOperatorCase,
  accounts: readonly PaymentAccount[],
): ChoiceOptions<string> => [
  { label: t("admin.payments.decision.choose"), value: "" },
  ...paymentDecisionSelections(context, accounts).map((selection) => ({
    hint: selectionHint(selection),
    label: selectionLabel(selection),
    value: paymentSelectionValue(selection),
  })),
];

export const createPaymentDecisionForm = (
  context: PaymentOperatorCase,
  accounts: readonly PaymentAccount[],
): PaymentDecisionForm => {
  const fields: DecisionFields = [
    {
      invalidMessage: t("admin.payments.decision_rejected.stale"),
      label: t("admin.payments.decision.label"),
      name: "decision",
      options: decisionOptions(context, accounts),
      required: true,
      requiredMessage: t("admin.payments.decision.required"),
      section: "decision",
      type: "select",
    },
    {
      label: t("admin.payments.reason.label"),
      maxlength: 300,
      minlength: 3,
      name: "reason",
      parse: (value) => value.trim(),
      required: true,
      requiredMessage: t("admin.payments.reason.required"),
      section: "reason",
      type: "textarea",
      validate: (value) =>
        value.trim().length < 3 ? t("admin.payments.reason.short") : null,
    },
    {
      label: t("admin.payments.revision"),
      name: "case_revision",
      parse: Number,
      required: true,
      section: "decision",
      type: "hidden",
    },
  ];
  return defineForm({ fields, id: "payment-case-decision" });
};

export const paymentSelectionFromValue = (
  value: string,
  context: PaymentOperatorCase,
  accounts: readonly PaymentAccount[],
): PaymentOperatorSelection => {
  const selection = paymentDecisionSelections(context, accounts).find(
    (candidate) => paymentSelectionValue(candidate) === value,
  );
  if (selection !== undefined) return selection;
  const [kind, provider, mode, accountId, ...extra] = value.split(":");
  if (
    kind === "assign_provider" &&
    provider !== undefined &&
    mode !== undefined &&
    accountId !== undefined &&
    extra.length === 0
  ) {
    const parsed = v.safeParse(PaymentOperatorSelectionSchema, {
      accountId,
      kind,
      mode,
      provider,
    });
    if (
      parsed.success &&
      parsed.output.kind === "assign_provider" &&
      paymentDecisionSelections(context, [parsed.output]).some(
        (candidate) => paymentSelectionValue(candidate) === value,
      )
    ) {
      return parsed.output;
    }
  }
  throw new Error("This payment decision is not available");
};
