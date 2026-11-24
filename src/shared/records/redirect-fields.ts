// effects: pure
/** The redirect fields: the stored row, the write input, the API bodies, the
 *  form, and the list columns derive from this one list. Both addresses are
 *  sealed text. */

import type { ShownField } from "#shared/rest/field-specs.ts";

/* jscpd:ignore-start -- a list of strings, not code */
export const REDIRECT_FIELDS = [
  {
    header: "redirects.col.from_path",
    hint: "fields.redirect.from_path_hint",
    key: "fromPath",
    kind: "sealedText",
    label: "fields.redirect.from_path",
    placeholder: "fields.redirect.from_path_placeholder",
    required: true,
  },
  {
    header: "redirects.col.to_url",
    hint: "fields.redirect.to_url_hint",
    key: "toUrl",
    kind: "sealedText",
    label: "fields.redirect.to_url",
    placeholder: "fields.redirect.to_url_placeholder",
    required: true,
  },
] as const satisfies readonly ShownField[];
/* jscpd:ignore-end */
