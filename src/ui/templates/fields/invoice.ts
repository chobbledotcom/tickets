/** The create-invoice form: the attendee number and the invoice number. */

import { t } from "#i18n";
import { defineFieldsForm } from "#shared/forms/definition.ts";
import type { Field } from "#shared/forms/field.ts";
import { parsePositiveInt } from "#shared/validation/number.ts";

const getInvoiceFields = () =>
  [
    {
      invalidMessage: t("invoices.error.attendee_invalid"),
      label: t("invoices.field.attendee"),
      name: "attendee_id",
      parse: parsePositiveInt,
      required: true,
      requiredMessage: t("invoices.error.attendee_required"),
      type: "number",
    },
    {
      invalidMessage: t("invoices.error.number_invalid"),
      label: t("invoices.field.number"),
      min: 1,
      name: "number",
      parse: parsePositiveInt,
      required: true,
      requiredMessage: t("invoices.error.number_required"),
      type: "number",
    },
  ] as const satisfies readonly Field[];

export const getInvoiceForm = defineFieldsForm(getInvoiceFields);
