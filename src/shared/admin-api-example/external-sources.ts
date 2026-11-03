/** Example bodies for the external sources directory endpoints. */

import type {
  AdminApiCreateExternalLinkBody,
  AdminApiCreateExternalSourceBody,
  AdminApiExternalSource,
  AdminApiExternalSourceLink,
  AdminApiUpdateExternalSourceBody,
} from "#shared/admin-api-external-sources.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import {
  childDocBase,
  crudDocs,
  type EndpointDoc,
  json,
} from "./endpoint-doc.ts";

/** One source as every answer shows it. */
export const ADMIN_API_EXAMPLE_EXTERNAL_SOURCE = {
  created: "2026-11-03T09:00:00.000Z",
  id: 1,
  name: "Stripe invoices",
  url_pattern: "https://dashboard.stripe.com/invoices/{external_id}",
} satisfies AdminApiExternalSource;

/** One link as every answer shows it. */
export const ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK = {
  created: "2026-11-03T09:05:00.000Z",
  external_id: "in_3Nx8Yz",
  id: 1,
  link_id: 7,
  link_type: "attendee",
  source_id: 1,
} satisfies AdminApiExternalSourceLink;

const CREATE_SOURCE_BODY = {
  name: "Shipping labels",
  url_pattern: "https://carrier.example/labels/{external_id}",
} satisfies AdminApiCreateExternalSourceBody;

const UPDATE_SOURCE_BODY = {
  name: "Stripe invoices",
  url_pattern: "https://dashboard.stripe.com/invoices/{external_id}",
} satisfies AdminApiUpdateExternalSourceBody;

const CREATE_LINK_BODY = {
  external_id: ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK.external_id,
  link_id: ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK.link_id,
  link_type: ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK.link_type,
} satisfies AdminApiCreateExternalLinkBody;

const UPDATE_LINK_BODY = {
  external_id: "in_4Qb2Lm",
  link_id: 7,
  link_type: "attendee",
} satisfies AdminApiCreateExternalLinkBody;

const LINKS_BASE = childDocBase(
  ADMIN_API_RESOURCES["external-sources"],
  "links",
);

export const EXTERNAL_SOURCE_ENDPOINTS: EndpointDoc[] = [
  ...crudDocs({
    createBody: CREATE_SOURCE_BODY,
    deleteBody: {
      confirm_identifier: ADMIN_API_EXAMPLE_EXTERNAL_SOURCE.name,
    },
    desc: [
      "List every external source with its URL pattern",
      "Get one external source by ID",
      "Create an external source",
      "Update an external source (all fields optional)",
      "Delete an external source and its links (requires name confirmation)",
    ],
    entry: ADMIN_API_RESOURCES["external-sources"],
    example: ADMIN_API_EXAMPLE_EXTERNAL_SOURCE,
    listResponse: {
      "external-sources": [ADMIN_API_EXAMPLE_EXTERNAL_SOURCE],
    },
    singular: "source",
    updateBody: UPDATE_SOURCE_BODY,
  }),
  {
    description:
      "List one source's links. Add ?external_id= to find the link that holds that external id, or ?link_type= and ?link_id= to find the links of one record. The external id is found through its blind index, so nothing is decrypted to search.",
    method: "GET",
    path: LINKS_BASE,
    response: json({ links: [ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK] }),
  },
  {
    description:
      "Link one record to its id at a source. link_type is attendee, listing, or group. The record must exist and the source must not already hold that external id.",
    method: "POST",
    path: LINKS_BASE,
    request: json(CREATE_LINK_BODY),
    response: json({ link: ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK }),
  },
  {
    description:
      "Change one link. The body carries all three fields, and the same checks as a create run against them.",
    method: "PUT",
    path: `${LINKS_BASE}/:linkId`,
    request: json(UPDATE_LINK_BODY),
    response: json({
      link: {
        ...ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK,
        external_id: UPDATE_LINK_BODY.external_id,
      },
    }),
  },
  {
    description: "Delete one link (requires the external id confirmation)",
    method: "DELETE",
    path: `${LINKS_BASE}/:linkId`,
    request: json({
      confirm_identifier: ADMIN_API_EXAMPLE_EXTERNAL_SOURCE_LINK.external_id,
    }),
    response: json({ status: "ok" }),
  },
];
