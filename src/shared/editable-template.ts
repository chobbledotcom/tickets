/**
 * Render and check an operator-editable Liquid template.
 *
 * Every surface that lets an owner rewrite a page or a message follows one
 * rule. The template text is the operator's own markup. The caller escapes
 * each data value before it reaches the engine. App-built fragments travel as
 * `SafeHtml`. A blank template renders the built-in default, so a cleared
 * settings box puts the site's own wording back.
 */

import { errorMessage } from "#shared/error-message.ts";
import { plainLiquidEngine } from "#shared/liquid-engine.ts";

export type EditableTemplate = {
  /** The operator's template. Empty means "use the default". */
  readonly template: string;
  readonly defaultTemplate: string;
};

/** Render one editable template against its data. The caller is responsible
 * for escaping the values in `data` that a person typed. */
export const renderEditableTemplate = async (
  { defaultTemplate, template }: EditableTemplate,
  data: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const operatorTemplate = template.trim();
  const rendered = await plainLiquidEngine().parseAndRender(
    operatorTemplate === "" ? defaultTemplate : operatorTemplate,
    data,
  );
  return rendered.trim();
};

/** Read a template for sense without rendering it. Returns null when the
 * engine can read it, or the engine's message when it cannot. A settings form
 * uses this to refuse a template that fails on every later page load. */
export const validateEditableTemplate = (template: string): string | null => {
  try {
    plainLiquidEngine().parse(template);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
};
