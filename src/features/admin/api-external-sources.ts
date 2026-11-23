/**
 * Admin JSON API for the external sources directory.
 *
 * A source is a place records are also kept. A link points one attendee,
 * listing, or group at its id there. The source name, its URL pattern, and
 * every external id are sealed with the owner key, so only an admin session
 * reads them.
 *
 * The resource belongs to the External sources feature, so the shared gate
 * refuses every route while that feature is off.
 */

import * as v from "valibot";
import { logActivity } from "#db/activity-log.ts";
import {
  createExternalSourceLink,
  deleteExternalSourceLink,
  getAllExternalSources,
  getExternalSourceLink,
  listExternalLinksForTarget,
  listExternalSourceLinks,
  lookupExternalLinks,
  requireExternalSourceLink,
  sourcesById,
  updateExternalSourceLink,
} from "#db/external-sources/queries.ts";
import {
  type ExternalLinkTarget,
  externalLinkTargets,
} from "#db/external-sources/target.ts";
import {
  EXTERNAL_LINK_KINDS,
  type ExternalLinkFilter,
  type ExternalLinkKind,
  ExternalLinkKindSchema,
  type ExternalLinkWrite,
  type ExternalSource,
  type ExternalSourceInput,
  type ExternalSourceLink,
} from "#db/external-sources/types.ts";
import { externalLinkUrl } from "#db/external-sources/url.ts";
import { records } from "#db/record-table.ts";
import { requiredMapValue } from "#fp";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn, RouteParams } from "#routes/router.ts";
import type { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { snakeCaseKeys } from "#shared/column-names.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { externalSourceRecord } from "#shared/records/external-sources.ts";
import {
  apiEntityGate,
  requireEntityField,
} from "#shared/rest/crud-parsers.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi, recordJsonPolicy } from "#shared/rest/record-api.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  isPositiveSafeInteger,
  parsePositiveInt,
} from "#shared/validation/number.ts";

/* jscpd:ignore-end */

/** The refused link kind message names the values the picklist accepts, so the
 *  two cannot drift apart. */
const LINK_KIND_VALUES = EXTERNAL_LINK_KINDS.join(", ");

/** One link kind, from a body field or a query value. */
const parseLinkKind = (value: unknown): Result<ExternalLinkKind> => {
  const parsed = v.safeParse(ExternalLinkKindSchema, value);
  return parsed.success
    ? okResult(parsed.output)
    : errorResult(`link_type must be one of: ${LINK_KIND_VALUES}`);
};

/** The external id a body carries: non-empty text of a bounded length. */
export const requiredExternalId = (
  body: Record<string, unknown>,
): Result<string> => {
  const externalId = requireEntityField(body, "external_id", null);
  if (externalId.ok && externalId.value.length > MAX_INPUT_LENGTH) {
    return errorResult(
      `external_id must be ${MAX_INPUT_LENGTH} characters or fewer`,
    );
  }
  return externalId;
};

/** One link write: the record's kind, which one, and its id at the source. An
 *  absent external id means the other system has not named the record yet. */
const parseLinkWrite = (
  body: Record<string, unknown>,
): Result<ExternalLinkWrite> => {
  const supplied = body.external_id;
  const externalId: Result<string | null> =
    supplied === undefined || supplied === null
      ? okResult(null)
      : requiredExternalId(body);
  if (!externalId.ok) return externalId;
  const linkType = parseLinkKind(body.link_type);
  if (!linkType.ok) return linkType;
  const { link_id: linkId } = body;
  if (typeof linkId !== "number" || !isPositiveSafeInteger(linkId)) {
    return errorResult("link_id must be a whole number of 1 or more");
  }
  return okResult({
    externalId: externalId.value,
    linkId,
    linkType: linkType.value,
  });
};

/** The one record a links read asks for. Both parts are required. */
const parseRecordSearch = (
  params: URLSearchParams,
): Result<ExternalLinkTarget> => {
  const rawType = params.get("link_type");
  const rawId = params.get("link_id");
  if (rawType === null || rawId === null) {
    return errorResult("link_type and link_id go together");
  }
  const linkType = parseLinkKind(rawType);
  if (!linkType.ok) return linkType;
  const linkId = parsePositiveInt(rawId);
  if (linkId === null) {
    return errorResult("link_id must be a whole number of 1 or more");
  }
  return okResult(externalLinkTargets.of(linkType.value)(linkId));
};

/** The filter a links read keeps: by external id, by the record a link points
 *  at, or no filter at all. */
const parseLinkFilter = (
  params: URLSearchParams,
): Result<ExternalLinkFilter> => {
  const externalId = params.get("external_id");
  if (externalId !== null) return okResult({ externalId, kind: "external" });
  if (params.get("link_type") === null && params.get("link_id") === null) {
    return okResult({ kind: "all" });
  }
  const target = parseRecordSearch(params);
  return target.ok
    ? okResult({
        kind: "target",
        linkId: target.value.id,
        linkType: target.value.kind,
      })
    : errorResult(target.error);
};

/** One link as a response carries it, under its column names. Its sealed
 *  index stays in the database. The source's pattern fills its address. */
const toLinkResponse = (
  { externalIdIndex: _index, ...link }: ExternalSourceLink,
  pattern: string,
) =>
  snakeCaseKeys({
    ...link,
    url: externalLinkUrl(pattern, link.externalId),
  });

/** The parent gate every link route runs. The read pins to the primary, so a
 *  link created right after its source can always see the source. */
const sourceGate = apiEntityGate(
  records.external_sources.findPrimary,
  "Source",
  recordJsonPolicy(externalSourceRecord),
);

/** Everything one link route receives: its request, the route parameters, the
 *  source the route names, and the raw body. */
type LinkRouteInputs = {
  body: Record<string, unknown>;
  params: RouteParams;
  request: Request;
  source: ExternalSource;
};

/** One link route under the source it names. The source read pins to the
 *  primary, so a link created right after its source can see the source. */
const underSource =
  (run: (inputs: LinkRouteInputs) => Promise<Response>): RouteHandlerFn =>
  (request, params) =>
    sourceGate(request, Number(params.sourceId), (source, body) =>
      run({ body, params, request, source }),
    );

/** One route that changes or deletes the link it names under the source. */
const withExistingLink = (
  run: (
    inputs: LinkRouteInputs & { link: ExternalSourceLink },
  ) => Promise<Response>,
): RouteHandlerFn =>
  underSource(async (inputs) => {
    const link = await getExternalSourceLink(
      inputs.source.id,
      Number(inputs.params.linkId),
    );
    if (link === null) return apiErrorResponse("Link not found", 404);
    return run({ ...inputs, link });
  });

/** One source's links, oldest first. A query narrows them to one external id
 *  or to the links of one record. */
const handleLinkList = underSource(async ({ request, source }) => {
  const filter = parseLinkFilter(new URL(request.url).searchParams);
  if (!filter.ok) return apiErrorResponse(filter.error);
  const links = await listExternalSourceLinks(source.id, filter.value);
  return jsonResponse({
    links: links.map((link) => toLinkResponse(link, source.urlPattern)),
  });
});

/** One read the owner's tools ask for, addressed by the query string. */
const ownerRead =
  (run: (params: URLSearchParams) => Promise<Response>): RouteHandlerFn =>
  (request) =>
    withAuth(request, recordJsonPolicy(externalSourceRecord), async () =>
      run(new URL(request.url).searchParams),
    );

/** One link as a cross-source answer carries it: the row, the address the
 *  source's pattern gives it, and the source's name. */
const toSourceLinkResponse = (
  link: ExternalSourceLink,
  source: ExternalSource,
) => ({
  ...toLinkResponse(link, source.urlPattern),
  source_name: source.name,
});

/** Every source's links that name one record, with the source that holds
 *  each. This is the read an admin record page needs: one request answers
 *  "where else does this appear?", whatever the number of sources. */
const handleLinkSearch = ownerRead(async (params) => {
  const target = parseRecordSearch(params);
  if (!target.ok) return apiErrorResponse(target.error);
  const [links, sources] = await Promise.all([
    listExternalLinksForTarget(target.value),
    getAllExternalSources(),
  ]);
  const byId = sourcesById(sources);
  return jsonResponse({
    links: links.map((link) =>
      toSourceLinkResponse(link, requiredMapValue(byId, link.sourceId)),
    ),
  });
});

/** The record one external id names, in every source that holds it. The id is
 *  hashed once per source, so nothing is decrypted to find it. */
const handleLinkLookup: RouteHandlerFn = ownerRead(async (params) => {
  const externalId = params.get("external_id");
  if (externalId === null || externalId.trim() === "") {
    return apiErrorResponse("external_id is required");
  }
  const matches = await lookupExternalLinks(externalId.trim());
  return jsonResponse({
    links: matches.map(({ link, source }) =>
      toSourceLinkResponse(link, source),
    ),
  });
});

/** The text an admin types to confirm one link's delete: its external id, or
 *  the record it names before the other system named it. */
const linkConfirmText = (link: ExternalSourceLink): string =>
  link.externalId ?? `${link.linkType} ${link.linkId}`;

/** The activity line one link write records, naming the reference and the
 *  source it belongs to. */
export const logLinkActivity = (
  action: string,
  reference: string,
  source: ExternalSource,
): Promise<unknown> =>
  logActivity(`External link '${reference}' ${action} '${source.name}'`);

/** The activity line one link write records. A link with no external id yet
 *  names the record instead. */
const logLink = (
  action: string,
  link: ExternalSourceLink,
  source: ExternalSource,
): Promise<unknown> => logLinkActivity(action, linkConfirmText(link), source);

/** Run one link write with its parsed input, or answer the parse refusal. */
const withLinkWrite = async (
  body: Record<string, unknown>,
  run: (write: ExternalLinkWrite) => Promise<Response>,
): Promise<Response> => {
  const write = parseLinkWrite(body);
  return write.ok ? run(write.value) : apiErrorResponse(write.error);
};

const handleLinkCreate = underSource(({ body, source }) =>
  withLinkWrite(body, async (write) => {
    const created = await createExternalSourceLink(source.id, write);
    if (!created.ok) {
      return apiErrorResponse(created.error.message, created.error.status);
    }
    await logLink("added to", created.value, source);
    return jsonResponse(
      { link: toLinkResponse(created.value, source.urlPattern) },
      201,
    );
  }),
);

const handleLinkUpdate = withExistingLink(({ body, link, source }) =>
  withLinkWrite(body, async (write) => {
    const updated = await updateExternalSourceLink(link, write);
    if (!updated.ok) {
      return apiErrorResponse(updated.error.message, updated.error.status);
    }
    const stored = await requireExternalSourceLink(source.id, link.id);
    await logLink("updated in", stored, source);
    return jsonResponse({ link: toLinkResponse(stored, source.urlPattern) });
  }),
);

const handleLinkDelete = withExistingLink(async ({ body, link, source }) => {
  const error = verifyIdentifierOrJsonError(
    linkConfirmText(link),
    body.confirm_identifier,
    "Link reference",
  );
  if (error) return apiErrorResponse(error);
  await deleteExternalSourceLink(link);
  await logLink("deleted from", link, source);
  return jsonResponse({ status: "ok" });
});

export const externalSourceApiRoutes = recordApi<
  (typeof ADMIN_API_RESOURCES)["external-sources"],
  RecordShapeOf<ExternalSource, ExternalSourceInput>
>(externalSourceRecord, {
  childHandlers: {
    links: {
      create: handleLinkCreate,
      delete: handleLinkDelete,
      update: handleLinkUpdate,
    },
  },
  customHandlers: {
    linkLookup: handleLinkLookup,
    linkSearch: handleLinkSearch,
    links: handleLinkList,
  },
  toCreateInput: (body) =>
    okResult({ name: body.name, urlPattern: body.url_pattern }),
  toUpdateInput: (body, existing) =>
    okResult({
      name: body.name ?? existing.name,
      urlPattern: body.url_pattern ?? existing.urlPattern,
    }),
});
