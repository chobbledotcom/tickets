import * as v from "valibot";
import {
  type SpecCatalog,
  specCasesWithContext,
} from "#scripts/specs/types.ts";
import { integerAtLeast } from "#shared/validation/number.ts";

const STABLE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const HEX_SHA_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
export const EVIDENCE_REPOSITORY = "chobbledotcom/tickets" as const;
const TrimmedTextSchema = v.pipe(v.string(), v.trim());
const TrimmedNonEmptyTextSchema = v.pipe(TrimmedTextSchema, v.nonEmpty());

const matchingText = (pattern: RegExp, message?: string) =>
  v.pipe(TrimmedNonEmptyTextSchema, v.regex(pattern, message));

/** A stable id is refused rather than tidied when it carries stray spaces: a
 * capture id is used as a key, so a tidied one would no longer be the id the
 * code that named it was written with. */
const stableId = (label: string) =>
  v.pipe(v.string(), v.regex(STABLE_ID_PATTERN, `Invalid ${label}`));

const PositiveIntegerSchema = integerAtLeast(1);

const EvidenceProfileNameSchema = v.picklist(["mobile"]);

const EvidencePresentationSchema = v.picklist([
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

/** A whole page address, ready to open. Placeholders are refused: a capture
 * whose address the story has to make up says so by leaving `path` out and
 * handing the finished address over with leaveEvidencePage. */
export const EvidencePathSchema = v.pipe(
  TrimmedTextSchema,
  v.check(
    (path) =>
      path.startsWith("data:text/html,") ||
      (path.startsWith("/") && !path.includes("{")),
    "Evidence path must be a whole address or HTML data page",
  ),
);

export const EvidenceCaptureDeclarationSchema = v.strictObject({
  caseId: stableId("evidence case id"),
  element: TrimmedNonEmptyTextSchema,
  id: stableId("capture id"),
  path: v.optional(EvidencePathSchema),
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
  name: TrimmedNonEmptyTextSchema,
});

const NamedEvidenceItemSchema = v.strictObject({
  description: TrimmedNonEmptyTextSchema,
  ...EvidenceItemSchema.entries,
});

/**
 * Where the story lives, so a reader of the manifest can open it. Feature
 * discovery accepts any path under specs/ ending in .feature, so this checks
 * the shape rather than the alphabet: a valid filename with a space or an
 * accent must not stop the evidence run.
 */
const FeatureUriSchema = v.pipe(
  TrimmedNonEmptyTextSchema,
  v.startsWith("specs/", "Feature uri must be under specs/"),
  v.endsWith(".feature", "Feature uri must be a .feature file"),
  v.check(
    (uri) => !uri.split("/").includes("..") && !uri.includes("\\"),
    "Feature uri must be a safe relative path",
  ),
);

const EvidenceStorySchema = v.strictObject({
  uri: FeatureUriSchema,
  ...NamedEvidenceItemSchema.entries,
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

/**
 * A list that must hold at least one thing, and no two things that answer to
 * the same name. The caller says what that name is and what to say when two
 * share it.
 */
const uniqueList = <Item>(
  member: v.GenericSchema<Item>,
  nameOf: (item: Item) => unknown,
  saidWhenTwoShare: string,
) =>
  v.pipe(
    v.array(member),
    v.minLength(1),
    v.check(
      (items: Item[]) => new Set(items.map(nameOf)).size === items.length,
      saidWhenTwoShare,
    ),
  );

const EvidenceAssetsSchema = uniqueList(
  EvidenceAssetSchema,
  ({ profile }) => profile,
  "Evidence asset profiles must be unique",
);

const EvidenceStepKeywordSchema = v.picklist([
  "Given",
  "When",
  "Then",
  "And",
  "But",
]);

const EvidenceCaptureSchema = v.strictObject({
  assets: EvidenceAssetsSchema,
  case: EvidenceItemSchema,
  id: stableId("capture id"),
  presentation: EvidencePresentationSchema,
  rule: NamedEvidenceItemSchema,
  steps: v.pipe(
    v.array(
      v.strictObject({
        keyword: EvidenceStepKeywordSchema,
        text: TrimmedNonEmptyTextSchema,
      }),
    ),
    v.minLength(1),
  ),
  story: EvidenceStorySchema,
});

const EvidenceCapturesSchema = v.pipe(
  uniqueList(
    EvidenceCaptureSchema,
    ({ id }) => id,
    "Evidence capture ids must be unique",
  ),
  v.check((captures) => {
    const paths = captures.flatMap(({ assets }) =>
      assets.map(({ path }) => path),
    );
    return new Set(paths).size === paths.length;
  }, "Evidence asset paths must be unique"),
);

export const EvidenceManifestSchema = v.strictObject({
  app: v.strictObject({
    commit: matchingText(COMMIT_PATTERN),
    repository: v.literal(EVIDENCE_REPOSITORY),
  }),
  captures: EvidenceCapturesSchema,
  schemaVersion: v.literal(2),
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
