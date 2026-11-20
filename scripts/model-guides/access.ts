import type { GuideSources } from "#scripts/model-guides/render.ts";
import {
  readSourceDefinition,
  type SourceDefinition,
} from "#scripts/model-guides/source.ts";
import {
  definitionIndex,
  readTlaModule,
  type TlaModule,
} from "#scripts/model-guides/tla.ts";
import type { ModelGuide } from "#scripts/model-guides/types.ts";
import {
  issue,
  type ModuleRun,
  sourceKey,
} from "#scripts/model-guides/validate.ts";
import { namesInDirectory, rethrowUnlessNotFound } from "#scripts/not-found.ts";
import type { VerificationModule } from "#scripts/verify-models/spec.ts";

/** The file reads that the guide check needs. */
export type GuideAccess = {
  readonly read: (path: string) => Promise<string>;
  readonly list: (directory: string) => Promise<readonly string[]>;
};

export const denoGuideAccess: GuideAccess = {
  list: (directory) => namesInDirectory(directory, (entry) => entry.isFile),
  read: (path) => Deno.readTextFile(path),
};

export const DOC_DIRECTORY = "docs/model-guides";

export const readModel = async (
  declaration: VerificationModule,
  read: (path: string) => Promise<string>,
): Promise<ModuleRun> => {
  const modelPath = `verification/${declaration.module}.tla`;
  const model = readTlaModule(modelPath, await read(modelPath));
  const helpers: TlaModule[] = [];
  const seen = new Set<string>();
  const pending = [...model.extends];
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const path = `verification/${name}.tla`;
    let content: string;
    try {
      content = await read(path);
    } catch (error) {
      rethrowUnlessNotFound(error);
      continue;
    }
    const helper = readTlaModule(path, content);
    helpers.push(helper);
    pending.push(...helper.extends);
  }
  return { declaration, index: definitionIndex(model, helpers), module: model };
};

export const loadSources = async (
  guide: ModelGuide,
  access: GuideAccess,
): Promise<{
  readonly definitions: ReadonlyMap<string, SourceDefinition>;
  readonly findings: string[];
}> => {
  const findings: string[] = [];
  const definitions = new Map<string, SourceDefinition>();
  for (const anchor of guide.steps.flatMap((step) => step.code)) {
    const key = sourceKey(anchor);
    if (definitions.has(key)) continue;
    try {
      const content = await access.read(anchor.path);
      definitions.set(
        key,
        readSourceDefinition(
          anchor.path,
          content,
          anchor.symbol,
          anchor.detail ?? "signature",
        ),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      findings.push(
        issue(
          `guide ${guide.module}`,
          "guide-source",
          `The guide names a declaration that cannot be read: ${anchor.path}#${anchor.symbol}. ${detail}`,
          "Read the declaration, or remove it from the step.",
        ),
      );
    }
  }
  return { definitions, findings };
};

export const sourcesFor = (
  run: ModuleRun,
  definitions: ReadonlyMap<string, SourceDefinition>,
): GuideSources => ({
  definition: (name) => run.index.get(name),
  model: run.module,
  source: (anchor) => definitions.get(sourceKey(anchor))!,
});
