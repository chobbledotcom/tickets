/**
 * Save the run sheet's Liquid templates from advanced settings.
 *
 * The route reads both boxes before it writes anything. A template the site
 * cannot read breaks the run sheet on every later load. The route refuses it
 * while the owner looks at the box. A blank box puts the built-in wording
 * back.
 */

import { settings } from "#db/settings.ts";
import { settingsHandler } from "#routes/admin/settings-helpers.ts";
import { validateEditableTemplate } from "#shared/editable-template.ts";

type RunSheetTemplates = {
  body: string;
  heading: string;
};

/** Why a box cannot be kept, or null when the site can read it. `box` is the
 * name a person reads, so the refusal points at the box to fix. */
const refusal = (box: string, template: string): string | null => {
  if (template === "") return null;
  const error = validateEditableTemplate(template);
  return error === null
    ? null
    : `Invalid template syntax in the ${box}: ${error}`;
};

const validateRunSheetTemplates = ({
  body,
  heading,
}: RunSheetTemplates): string | null => {
  const bodyRefusal = refusal("day body", body);
  return bodyRefusal === null ? refusal("day heading", heading) : bodyRefusal;
};

/** Handle POST /admin/settings/logistics-run-sheet. */
export const handleLogisticsRunSheetPost = settingsHandler<RunSheetTemplates>({
  advanced: true,
  extract: (form) => ({
    body: form.getString("body"),
    heading: form.getString("heading"),
  }),
  formId: "settings-logistics-run-sheet",
  label: "Logistics run sheet template",
  save: async ({ body, heading }) => {
    await Promise.all([
      settings.update.logisticsRunSheetBody(body.trim()),
      settings.update.logisticsRunSheetHeading(heading.trim()),
    ]);
  },
  validate: validateRunSheetTemplates,
});
