import * as v from "valibot";
import {
  type SpecCatalog,
  specCasesWithContext,
} from "#scripts/specs/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

const STABLE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HEX_SHA_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const TrimmedTextSchema = v.pipe(v.string(), v.trim());
const TrimmedNonEmptyTextSchema = v.pipe(TrimmedTextSchema, v.nonEmpty());

const matchingText = (pattern: RegExp, message?: string) =>
  v.pipe(TrimmedNonEmptyTextSchema, v.regex(pattern, message));

const stableId = (label: string) =>
  matchingText(STABLE_ID_PATTERN, `Invalid ${label}`);

const PositiveIntegerSchema = integerAtLeast(1);

export const EvidenceProfileNameSchema = v.picklist(["mobile"]);

export const EvidencePresentationSchema = v.picklist([
  "canonical",
  "branded",
  "editorial",
]);

const EvidenceProfilesSchema = v.pipe(
  v.array(EvidenceProfileNameSchema, "Invalid evidence profile"),
  v.minLength(1, "At least one evidence profile is required"),
  v.check(
    (profiles) => new Set(profiles).size === profiles.length,
    "Evidence profiles must be unique",
  ),
);

export const EvidenceCaptureDeclarationSchema = v.strictObject({
  caseId: stableId("evidence case id"),
  css: v.optional(v.string()),
  element: TrimmedNonEmptyTextSchema,
  id: stableId("capture id"),
  path: v.pipe(
    TrimmedTextSchema,
    v.startsWith("/", "Evidence path must start with /"),
  ),
  presentation: EvidencePresentationSchema,
  profiles: EvidenceProfilesSchema,
});

export type EvidenceCaptureDeclaration = v.InferOutput<
  typeof EvidenceCaptureDeclarationSchema
>;

const EvidenceCaptureDeclarationsSchema = v.pipe(
  v.array(EvidenceCaptureDeclarationSchema),
  v.minLength(1, "At least one evidence capture is required"),
);

const EvidenceItemSchema = v.strictObject({
  id: stableId("manifest item id"),
  name: v.string(),
});

const NamedEvidenceItemSchema = v.strictObject({
  description: v.string(),
  ...EvidenceItemSchema.entries,
});

const EvidenceViewportSchema = v.strictObject({
  deviceScaleFactor: v.pipe(v.number(), v.minValue(1)),
  height: PositiveIntegerSchema,
  width: PositiveIntegerSchema,
});

const EvidenceAssetSchema = v.strictObject({
  height: PositiveIntegerSchema,
  mediaType: v.literal("image/png"),
  path: matchingText(/^assets\/[a-z0-9.-]+\.png$/),
  profile: EvidenceProfileNameSchema,
  sha256: matchingText(HEX_SHA_PATTERN),
  viewport: EvidenceViewportSchema,
  width: PositiveIntegerSchema,
});

const EvidenceCaptureSchema = v.strictObject({
  assets: v.pipe(v.array(EvidenceAssetSchema), v.minLength(1)),
  case: EvidenceItemSchema,
  id: stableId("capture id"),
  presentation: EvidencePresentationSchema,
  rule: NamedEvidenceItemSchema,
  steps: v.array(
    v.strictObject({
      keyword: TrimmedNonEmptyTextSchema,
      text: TrimmedNonEmptyTextSchema,
    }),
  ),
  story: NamedEvidenceItemSchema,
});

export const EvidenceManifestSchema = v.strictObject({
  app: v.strictObject({
    commit: matchingText(COMMIT_PATTERN),
    repository: v.literal("chobbledotcom/tickets"),
  }),
  captures: v.array(EvidenceCaptureSchema),
  schemaVersion: v.literal(1),
});

export type EvidenceManifest = v.InferOutput<typeof EvidenceManifestSchema>;

const catalogCaseIds = (catalog: SpecCatalog): Set<string> =>
  new Set(specCasesWithContext(catalog).map(({ specCase }) => specCase.id));

export const parseEvidenceDeclarations = (
  input: unknown,
  catalog: SpecCatalog,
): EvidenceCaptureDeclaration[] => {
  const declarations = v.parse(EvidenceCaptureDeclarationsSchema, input);
  const captureIds = new Set<string>();
  const caseIds = catalogCaseIds(catalog);
  for (const declaration of declarations) {
    if (captureIds.has(declaration.id)) {
      throw new Error(`Duplicate evidence capture id ${declaration.id}`);
    }
    if (!caseIds.has(declaration.caseId)) {
      throw new Error(`Unknown @case:${declaration.caseId} in evidence`);
    }
    captureIds.add(declaration.id);
  }
  return declarations;
};

export const evidenceTagExpression = (
  declarations: readonly EvidenceCaptureDeclaration[],
): string =>
  [...new Set(declarations.map(({ caseId }) => caseId))]
    .sort()
    .map((caseId) => `@case:${caseId}`)
    .join(" or ");
