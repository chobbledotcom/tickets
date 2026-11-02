import type { ModelDataSource } from "#scripts/verify-models/data.ts";

export type CheckPhase = "initial" | "step";

/** The checker and the model source that a declaration owns. */
export type ModelLanguage = "tla" | "quint";

const MODEL_EXTENSION: Record<ModelLanguage, string> = {
  quint: "qnt",
  tla: "tla",
};

/** The one source file a declaration owns, whatever its language. */
export const sourceFileFor = (
  module: string,
  language: ModelLanguage,
): string => `verification/${modelFileName(module, language)}`;

/** The checker's file name for a module, in its language. */
export const modelFileName = (
  module: string,
  language: ModelLanguage,
): string => `${module}.${MODEL_EXTENSION[language]}`;

/** The fact module a producer writes beside its model. */
export const dataFileName = (module: string, language: ModelLanguage): string =>
  modelFileName(`${module}Data`, language);

export type ModelControl = {
  readonly name: string;
  readonly phase: CheckPhase;
  readonly data: ModelDataSource;
};

type ModuleContext = {
  readonly module: string;
  readonly language: ModelLanguage;
  readonly context: readonly string[];
};

export type VerificationModule = ModuleContext &
  (
    | { readonly kind: "helper" }
    | {
        readonly kind: "model";
        readonly data: ModelDataSource;
        readonly controls: readonly [ModelControl, ...ModelControl[]];
      }
  );

/** Load a producer only when the checker requests its data. */
export const dataFrom =
  <Module>(load: () => Promise<Module>) =>
  (select: (module: Module) => ModelDataSource): ModelDataSource =>
  async () =>
    select(await load())();

/** Review context is source code under the declared repository roots. */
export const isReviewSourcePath = (path: string): boolean =>
  /^(?:src|scripts|verification)\/.+\.(?:[cm]?[jt]sx?|tla|qnt)$/.test(path) &&
  !path.includes("\\") &&
  path.split("/").every((part) => part !== "" && !part.startsWith("."));
