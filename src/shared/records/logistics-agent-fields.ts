/** The logistics-agent fields: the stored row, the write input, the codecs,
 *  the form, and the list columns all derive from this one list. */

import type { ShownField } from "#shared/rest/field-specs.ts";

/* jscpd:ignore-start -- a list of field records, not code */
export const LOGISTICS_AGENT_FIELDS = [
  {
    header: "common.name",
    key: "name",
    kind: "name",
    label: "logistics.agent_name",
    placeholder: "logistics.agent_name_placeholder",
  },
] as const satisfies readonly ShownField[];
/* jscpd:ignore-end */
