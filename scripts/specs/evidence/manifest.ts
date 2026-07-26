import {
  AttachmentContentEncoding,
  type Envelope,
  type GherkinDocument,
  type Pickle,
} from "@cucumber/messages";
import { join } from "@std/path";
import sharp from "sharp";
import * as v from "valibot";
import { sha256Hex } from "#scripts/checksum.ts";
import { removeIfPresent } from "#scripts/cleanup.ts";
import { SCREENSHOT_PROFILES } from "#scripts/screenshots/profile.ts";
import type { SpecCatalog } from "#scripts/specs/types.ts";
import { requireValue } from "#shared/required-value.ts";
import { resolveEvidenceScenario } from "./resolve.ts";
import {
  type EvidenceCaptureDeclaration,
  type EvidenceManifest,
  EvidenceManifestSchema,
} from "./schema.ts";

const REPOSITORY = "chobbledotcom/tickets" as const;

export interface EvidenceBundle {
  assets: Map<string, Uint8Array>;
  manifest: EvidenceManifest;
}

export interface EvidenceBundleInput {
  catalog: SpecCatalog;
  commit: string;
  declarations: readonly EvidenceCaptureDeclaration[];
  messages: readonly Envelope[];
}

interface IndexedMessages {
  documents: Map<string, GherkinDocument>;
  pickleIdByStartedCase: Map<string, string>;
  pickles: Map<string, Pickle>;
}

interface CollectedAttachment {
  bytes: Uint8Array;
  scenario: ReturnType<typeof resolveEvidenceScenario>;
}

const filenameFor = (
  declaration: EvidenceCaptureDeclaration,
  profile: string,
): string => `${declaration.id}--${profile}.png`;

const attachmentKey = (caseId: string, filename: string): string =>
  `${caseId}\0${filename}`;

const indexMessages = (messages: readonly Envelope[]): IndexedMessages => {
  const documents = new Map<string, GherkinDocument>();
  const pickles = new Map<string, Pickle>();
  const pickleIdByTestCase = new Map<string, string>();
  const pickleIdByStartedCase = new Map<string, string>();
  for (const message of messages) {
    if (message.gherkinDocument?.uri) {
      documents.set(message.gherkinDocument.uri, message.gherkinDocument);
    }
    if (message.pickle) pickles.set(message.pickle.id, message.pickle);
    if (message.testCase) {
      pickleIdByTestCase.set(message.testCase.id, message.testCase.pickleId);
    }
  }
  for (const message of messages) {
    const started = message.testCaseStarted;
    if (!started) continue;
    const pickleId = pickleIdByTestCase.get(started.testCaseId);
    if (!pickleId) {
      throw new Error(`No Pickle for Cucumber test case ${started.testCaseId}`);
    }
    pickleIdByStartedCase.set(started.id, pickleId);
  }
  return { documents, pickleIdByStartedCase, pickles };
};

const attachmentBytes = (
  attachment: NonNullable<Envelope["attachment"]>,
): Uint8Array => {
  if (attachment.contentEncoding !== AttachmentContentEncoding.BASE64) {
    throw new Error("Evidence PNG attachment is not base64 encoded");
  }
  return Uint8Array.fromBase64(attachment.body);
};

const scenarioForAttachment = (
  attachment: NonNullable<Envelope["attachment"]>,
  filename: string,
  catalog: SpecCatalog,
  index: IndexedMessages,
): ReturnType<typeof resolveEvidenceScenario> => {
  const startedId = attachment.testCaseStartedId;
  if (!startedId) throw new Error("Evidence attachment has no running case");
  const pickleId = index.pickleIdByStartedCase.get(startedId);
  const pickle = pickleId ? index.pickles.get(pickleId) : undefined;
  if (!pickle) {
    throw new Error(`No Cucumber scenario for attachment ${filename}`);
  }
  const document = index.documents.get(pickle.uri);
  if (!document) throw new Error(`No Gherkin document for ${pickle.uri}`);
  return resolveEvidenceScenario(catalog, document, pickle);
};

const collectAttachment = (
  message: Envelope,
  catalog: SpecCatalog,
  index: IndexedMessages,
  expected: ReadonlySet<string>,
  collected: Map<string, CollectedAttachment>,
): void => {
  const attachment = message.attachment;
  if (!attachment) return;
  const filename = attachment.fileName;
  if (!filename || attachment.mediaType !== "image/png") {
    throw new Error(
      `Unexpected evidence attachment ${filename ?? "without filename"}`,
    );
  }
  const scenario = scenarioForAttachment(attachment, filename, catalog, index);
  const key = attachmentKey(scenario.case.id, filename);
  if (!expected.has(key)) {
    throw new Error(`Unexpected evidence attachment ${filename}`);
  }
  if (collected.has(key)) {
    throw new Error(`Duplicate evidence attachment ${filename}`);
  }
  collected.set(key, { bytes: attachmentBytes(attachment), scenario });
};

const collectAttachments = (
  input: EvidenceBundleInput,
): Map<string, CollectedAttachment> => {
  const expected = new Set(
    input.declarations.flatMap((declaration) =>
      declaration.profiles.map((profile) =>
        attachmentKey(declaration.caseId, filenameFor(declaration, profile)),
      ),
    ),
  );
  const collected = new Map<string, CollectedAttachment>();
  const index = indexMessages(input.messages);
  for (const message of input.messages) {
    collectAttachment(message, input.catalog, index, expected, collected);
  }
  for (const key of expected) {
    if (collected.has(key)) continue;
    throw new Error(
      `Missing evidence attachment ${key.slice(key.indexOf("\0") + 1)}`,
    );
  }
  return collected;
};

const imageSize = async (
  bytes: Uint8Array,
): Promise<{ height: number; width: number }> => {
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== "png" || !metadata.width || !metadata.height) {
    throw new Error("Evidence attachment is not a sized PNG");
  }
  return { height: metadata.height, width: metadata.width };
};

export const buildEvidenceBundle = async (
  input: EvidenceBundleInput,
): Promise<EvidenceBundle> => {
  const attachments = collectAttachments(input);
  const assets = new Map<string, Uint8Array>();
  const captures = await Promise.all(
    [...input.declarations]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(async (declaration) => {
        const firstProfile = requireValue(
          declaration.profiles[0],
          `No evidence profile for ${declaration.id}`,
        );
        const scenario = requireValue(
          attachments.get(
            attachmentKey(
              declaration.caseId,
              filenameFor(declaration, firstProfile),
            ),
          ),
          `No evidence scenario for ${declaration.id}`,
        ).scenario;
        const captureAssets = await Promise.all(
          [...declaration.profiles].sort().map(async (profileName) => {
            const filename = filenameFor(declaration, profileName);
            const attachment = requireValue(
              attachments.get(attachmentKey(declaration.caseId, filename)),
              `Missing evidence attachment ${filename}`,
            );
            const path = `assets/${filename}`;
            assets.set(path, attachment.bytes);
            const profile = SCREENSHOT_PROFILES[profileName];
            return {
              ...(await imageSize(attachment.bytes)),
              mediaType: "image/png" as const,
              path,
              profile: profileName,
              sha256: await sha256Hex(attachment.bytes),
              viewport: {
                deviceScaleFactor: profile.deviceScaleFactor,
                height: profile.viewport.height,
                width: profile.viewport.width,
              },
            };
          }),
        );
        return {
          assets: captureAssets,
          case: scenario.case,
          id: declaration.id,
          presentation: declaration.presentation,
          rule: scenario.rule,
          steps: scenario.steps,
          story: scenario.story,
        };
      }),
  );
  const manifest = v.parse(EvidenceManifestSchema, {
    app: { commit: input.commit, repository: REPOSITORY },
    captures,
    schemaVersion: 1,
  });
  return { assets, manifest };
};

const evidenceManifestJson = (manifest: EvidenceManifest): string =>
  `${JSON.stringify(manifest, null, 2)}\n`;

export const clearEvidenceOutput = async (outputDir: string): Promise<void> => {
  await removeIfPresent(outputDir, (path) =>
    Deno.remove(path, { recursive: true }),
  );
};

export const writeEvidenceBundle = async (
  outputDir: string,
  bundle: EvidenceBundle,
): Promise<void> => {
  await clearEvidenceOutput(outputDir);
  const assetsDir = join(outputDir, "assets");
  await Deno.mkdir(assetsDir, { recursive: true });
  await Promise.all(
    [...bundle.assets].map(([path, bytes]) =>
      Deno.writeFile(join(outputDir, path), bytes),
    ),
  );
  await Deno.writeTextFile(
    join(outputDir, "manifest.json"),
    evidenceManifestJson(bundle.manifest),
  );
};
