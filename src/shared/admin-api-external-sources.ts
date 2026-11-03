/**
 * The wire shapes of the external sources admin API: the rows every answer
 * carries and the bodies every write accepts.
 *
 * They sit beside the shared admin API resource table rather than inside it.
 * Two tables and their links need more shapes than one file can hold. The
 * resource entry itself stays in `admin-api-resources.ts`, so the paths and
 * the envelopes still come from one table.
 */

import * as v from "valibot";
import {
  ExternalLinkKindSchema,
  ExternalUrlPatternSchema,
} from "#db/external-sources/types.ts";

/** The writable fields of one source: the name an admin reads, and the URL
 *  pattern the source uses for one external id. */
const ExternalSourceWriteFields = {
  name: v.string(),
  url_pattern: ExternalUrlPatternSchema,
};

/** One source as the admin API answers with it. The row schema stays open —
 *  the server owns the rest of the stored row (its created stamp). */
export const ExternalSourceRowSchema = v.looseObject({
  ...ExternalSourceWriteFields,
  created: v.string(),
  id: v.number(),
});

export type AdminApiExternalSource = v.InferOutput<
  typeof ExternalSourceRowSchema
>;

/** One record's external id at one source. The blind index stays in the
 *  database, so no row carries it. A link made before the other system named
 *  the record has no external id yet. */
export const ExternalSourceLinkRowSchema = v.looseObject({
  created: v.string(),
  external_id: v.nullable(v.string()),
  id: v.number(),
  link_id: v.number(),
  link_type: ExternalLinkKindSchema,
  source_id: v.number(),
});

export type AdminApiExternalSourceLink = v.InferOutput<
  typeof ExternalSourceLinkRowSchema
>;

/** The body a source create carries. */
export const CreateExternalSourceBodySchema = v.object(
  ExternalSourceWriteFields,
);
export type AdminApiCreateExternalSourceBody = v.InferOutput<
  typeof CreateExternalSourceBodySchema
>;

/** The body a source update carries: every writable field optional. */
export const UpdateExternalSourceBodySchema = v.partial(
  v.object(ExternalSourceWriteFields),
);
export type AdminApiUpdateExternalSourceBody = v.InferOutput<
  typeof UpdateExternalSourceBodySchema
>;

/** The body a link write carries: the kind of record, which one, and its id at
 *  the source. The same shape serves the link's create and its update. Leave
 *  external_id out when the other system has not named the record yet. */
export const CreateExternalLinkBodySchema = v.object({
  external_id: v.optional(v.string()),
  link_id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  link_type: ExternalLinkKindSchema,
});
export type AdminApiCreateExternalLinkBody = v.InferOutput<
  typeof CreateExternalLinkBodySchema
>;
