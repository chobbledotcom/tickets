/**
 * The attribute editor forms. They live beside the other admin field
 * definitions, so the page template and the saving route share one
 * definition without either importing the other.
 */

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
