/**
 * The doc entries of the attributes resource: the record, then its options.
 * The paths and the body fields come from the resource table. The docs
 * therefore cannot disagree with the server about them.
 */

import type {
  CreateAttributeBody,
  UpdateAttributeBody,
} from "#routes/admin/api-attributes.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import type { DeleteBody } from "#shared/rest/crud-parsers.ts";
import type { WriteAccess } from "#shared/rest/field-specs.ts";
import {
  choiceWriteDocs,
  type EndpointDoc,
  recordDocsFor,
} from "./endpoint-doc.ts";

/** Example attribute response: the attribute and its options in display
 * order. */
const ADMIN_API_EXAMPLE_ATTRIBUTE = {
  id: 6,
  name: "Difficulty",
  options: [
    { attribute_id: 6, id: 11, sort_order: 0, text: "Easy" },
    { attribute_id: 6, id: 12, sort_order: 1, text: "Hard" },
  ],
  sort_order: 2,
};

const ADMIN_API_ATTRIBUTE_CREATE_BODY = {
  name: "Difficulty",
} satisfies CreateAttributeBody;

const ADMIN_API_ATTRIBUTE_UPDATE_BODY = {
  name: "Difficulty (Updated)",
} satisfies UpdateAttributeBody;

const ADMIN_API_ATTRIBUTE_DELETE_BODY = {
  confirm_identifier: "Difficulty",
} satisfies DeleteBody;

/** The documented attribute routes: the record, then its options. */
export const attributeDocs = (access: WriteAccess): EndpointDoc[] => {
  return [
    ...recordDocsFor(access)(
      "attributes",
      "an attribute",
      {
        createBody: ADMIN_API_ATTRIBUTE_CREATE_BODY,
        deleteBody: ADMIN_API_ATTRIBUTE_DELETE_BODY,
        example: ADMIN_API_EXAMPLE_ATTRIBUTE,
        // A new attribute has no options yet.
        newRecordDefaults: { options: [] },
        updateBody: ADMIN_API_ATTRIBUTE_UPDATE_BODY,
      },
      "owner",
    ),
    ...choiceWriteDocs([ADMIN_API_RESOURCES.attributes, "options"], {
      added: { attribute_id: 6, id: 13, sort_order: 2, text: "Medium" },
      desc: [
        "Add an option to an attribute (owner only). The answer shows the attribute with its full option list, new option last.",
        "Rename an attribute option (owner only). The answer shows the attribute with its full option list.",
        "Delete an attribute option (owner only, requires the option text as confirmation).",
      ],
      record: ADMIN_API_EXAMPLE_ATTRIBUTE,
      rename: ["Hard", "Very hard"],
    }),
  ];
};
