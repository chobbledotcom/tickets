/**
 * Admin JSON API for the external sources directory.
 *
 * A source is a place records are also kept. A link points one attendee,
 * listing, or group at its id there. The source name, its URL pattern, and
 * every external id are sealed with the owner key, so only an admin session
 * reads them.
 *
 * Every route answers 403 while the External sources feature is off, so the
 * setting decides whether the API is there at all.
 */

/* jscpd:ignore-start -- imports */
import { mapValues } from "@std/collections";
import * as v from "valibot";
import { logActivity } from "#db/activity-log.ts";
import {
  createExternalSourceLink,
  deleteExternalSource,
  deleteExternalSourceLink,
  getAllExternalSources,
  getExternalSource,
  getExternalSourceLink,
  listExternalLinksForTarget,
  listExternalSourceLinks,
  lookupExternalLinks,
  requireExternalSourceLink,
  sourcesById,
  updateExternalSourceLink,
} from "#db/external-sources/queries.ts";
import { externalSourcesTable } from "#db/external-sources/tables.ts";
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
  ExternalUrlPatternSchema,
} from "#db/external-sources/types.ts";
import { externalLinkUrl } from "#db/external-sources/url.ts";
import { settings } from "#db/settings.ts";
import { requiredMapValue } from "#fp";
import { t } from "#i18n";
import { verifyIdentifierOrJsonError } from "#routes/admin/confirmation.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { ADMIN_API, withAuth } from "#routes/auth.ts";
import { jsonResponse } from "#routes/response.ts";
import type { RouteHandlerFn, RouteParams } from "#routes/router.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { featureGate } from "#shared/response-steps.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import {
  apiEntityGate,
  requireEntityField,
} from "#shared/rest/crud-parsers.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  isPositiveSafeInteger,
  parsePositiveInt,
} from "#shared/validation/number.ts";
import { validatorFor } from "#shared/validation/parse.ts";

/* jscpd:ignore-end */

/** The refused link kind message names the values the picklist accepts, so the
 *  two cannot drift apart. */
const LINK_KIND_VALUES = EXTERNAL_LINK_KINDS.join(", ");

/** One source write body after the resource table's schema validates it. */
type SourceWriteBody = {
  name?: string | undefined;
  url_pattern?: string | undefined;
};

/** One source's own fields: the name and the URL pattern, each trimmed, not
 *  empty, and no longer than a short input. */
const sourceField = (
  body: SourceWriteBody,
  field: "name" | "url_pattern",
  stored: string,
): Result<string> => {
  const value = (body[field] ?? stored).trim();
  if (value === "") return errorResult(`${field} cannot be empty`);
  return value.length > MAX_INPUT_LENGTH
    ? errorResult(`${field} must be ${MAX_INPUT_LENGTH} characters or fewer`)
    : okResult(value);
};

/** The source input a create or an update stores. A silent field keeps the
 *  stored value on an update. */
const sourceInput = (
  body: SourceWriteBody,
  existing: ExternalSource | null,
): Result<ExternalSourceInput> => {
  const name = sourceField(body, "name", existing?.name ?? "");
  if (!name.ok) return name;
  const urlPattern = sourceField(
    body,
    "url_pattern",
    existing?.url_pattern ?? "",
  );
  if (!urlPattern.ok) return urlPattern;
  const invalidPattern = validatorFor(ExternalUrlPatternSchema)(
    urlPattern.value,
  );
  if (invalidPattern !== null) return errorResult(invalidPattern);
  return okResult({ name: name.value, urlPattern: urlPattern.value });
};

/** One link kind, from a body field or a query value. */
const parseLinkKind = (value: unknown): Result<ExternalLinkKind> => {
  const parsed = v.safeParse(ExternalLinkKindSchema, value);
  return parsed.success
    ? okResult(parsed.output)
    : errorResult(`link_type must be one of: ${LINK_KIND_VALUES}`);
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
      : requireEntityField(body, "external_id", null);
  if (!externalId.ok) return externalId;
  if (externalId.value !== null && externalId.value.length > MAX_INPUT_LENGTH) {
    return errorResult(
      `external_id must be ${MAX_INPUT_LENGTH} characters or fewer`,
    );
  }
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

/** One link as a response carries it: its sealed index stays in the database,
 *  and its address is filled from the source's pattern. */
const toLinkResponse = (
  { external_id_index: _index, ...link }: ExternalSourceLink,
  pattern: string,
): Omit<ExternalSourceLink, "external_id_index"> & { url: string | null } => ({
  ...link,
  url: externalLinkUrl(pattern, link.external_id),
});

/** The parent gate every link route runs. The read pins to the primary, so a
 *  link created right after its source can always see the source. */
const sourceGate = apiEntityGate(
  externalSourcesTable.findByIdPrimary,
  "Source",
  ADMIN_API,
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
    links: links.map((link) => toLinkResponse(link, source.url_pattern)),
  });
});

/** One read the owner's tools ask for, addressed by the query string. */
const ownerRead =
  (run: (params: URLSearchParams) => Promise<Response>): RouteHandlerFn =>
  (request) =>
    withAuth(request, ADMIN_API, async () =>
      run(new URL(request.url).searchParams),
    );

/** One link as a cross-source answer carries it: the row, the address the
 *  source's pattern gives it, and the source's name. */
const toSourceLinkResponse = (
  link: ExternalSourceLink,
  source: ExternalSource,
) => ({
  ...toLinkResponse(link, source.url_pattern),
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
      toSourceLinkResponse(
        link,
        requiredMapValue(
          byId,
          link.source_id,
          "Every link names a source in the directory",
        ),
      ),
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

/** The activity line one link write records, naming the record and the source
 *  it belongs to. A link with no external id yet names the record instead. */
const logLink = (
  action: string,
  link: { external_id: string | null; link_id: number; link_type: string },
  source: ExternalSource,
): Promise<unknown> =>
  logActivity(
    `External link '${link.external_id ?? `${link.link_type} ${link.link_id}`}' ${action} '${source.name}'`,
  );

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
    if (!created.ok) return apiErrorResponse(created.error);
    await logLink("added to", created.value, source);
    return jsonResponse(
      { link: toLinkResponse(created.value, source.url_pattern) },
      201,
    );
  }),
);

const handleLinkUpdate = withExistingLink(({ body, link, source }) =>
  withLinkWrite(body, async (write) => {
    const updated = await updateExternalSourceLink(link, write);
    if (!updated.ok) return apiErrorResponse(updated.error);
    const stored = await requireExternalSourceLink(source.id, link.id);
    await logLink("updated in", stored, source);
    return jsonResponse({ link: toLinkResponse(stored, source.url_pattern) });
  }),
);

/** The text an admin types to confirm one link's delete: its external id, or
 *  the record it names before the other system named it. */
const linkConfirmText = (link: ExternalSourceLink): string =>
  link.external_id ?? `${link.link_type} ${link.link_id}`;

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

/** While the External sources feature is off, every route answers the same
 *  refusal. Wrapping the route map keeps that gate in one place, the way the
 *  built-sites section gates its own routes. */
const externalSourcesGate = featureGate(
  () => settings.features.externalSources,
  () => apiErrorResponse(t("features.external_sources.disabled"), 403),
);

const externalSourcesOnly =
  (handler: RouteHandlerFn): RouteHandlerFn =>
  (request, params) =>
    externalSourcesGate(() => handler(request, params));

export const externalSourceApiRoutes = mapValues(
  defineCrudApi<
    (typeof ADMIN_API_RESOURCES)["external-sources"],
    ExternalSource,
    ExternalSourceInput
  >(ADMIN_API_RESOURCES["external-sources"], {
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
    getAll: getAllExternalSources,
    lookup: getExternalSource,
    // Read-your-writes: the create and update answers re-read the row from the
    // primary, so a lagging replica cannot miss the row the write just made.
    lookupAfterWrite: externalSourcesTable.findByIdPrimary,
    nameField: "name",
    onDelete: (id) => deleteExternalSource(Number(id)),
    policy: ADMIN_API,
    table: externalSourcesTable,
    toCreateInput: (body) => sourceInput(body, null),
    toUpdateInput: sourceInput,
  }),
  externalSourcesOnly,
);
