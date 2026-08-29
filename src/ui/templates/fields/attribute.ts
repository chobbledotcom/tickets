/** Attribute editor form fields (name and option text). */

import { defineTextForm } from "#shared/forms/definition.ts";

export const attributeNameForm = defineTextForm(
  "Attribute name",
  "name",
  "e.g. Difficulty",
);

export const attributeOptionForm = defineTextForm(
  "Option text",
  "text",
  "e.g. Beginner",
);
