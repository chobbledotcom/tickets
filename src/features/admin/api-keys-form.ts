/** The create-API-key form: one required name box. Lives outside the route
 *  module so the template can import it without a template ⇄ route cycle. */
import { defineForm } from "#shared/forms/definition.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";

export const apiKeyForm = defineForm({
  fields: [
    {
      label: "Name",
      maxlength: MAX_INPUT_LENGTH,
      name: "name",
      placeholder: "e.g. CI Pipeline",
      required: true,
      type: "text" as const,
    },
  ] as const,
});
