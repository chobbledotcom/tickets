import type ts from "typescript";
import type { FieldName } from "./names.ts";
import type { Step } from "./steps.ts";

export interface WalkState {
  activeReferences: ReadonlySet<ts.Node>;
  activeTargets: ReadonlySet<ts.Symbol>;
  activeTypes: ReadonlySet<ts.Type>;
  argumentsByParameter: ReadonlyMap<ts.Symbol, ts.TypeNode>;
  currentTarget: ts.Symbol;
  recordsFields: boolean;
  rootTarget: ts.Symbol;
}

export type RememberField = (
  path: readonly Step[],
  name: FieldName,
  symbol?: ts.Symbol,
) => readonly Step[];

export type IsExportedTarget = (target: ts.Symbol) => boolean;

export interface VisitContext {
  checker: ts.TypeChecker;
  isExportedTarget: IsExportedTarget;
  remember: RememberField;
}

type Visit<Value, Result> = (
  path: readonly Step[],
  value: Value,
  state: WalkState,
) => Result;

export type VisitNode = Visit<ts.Node, void>;

export type VisitType = Visit<ts.Type, void>;

export type TryVisitNode = Visit<ts.Node, boolean>;

export type TryVisitType = Visit<ts.Type, boolean>;

export type PathAtNode = Visit<ts.Node, readonly Step[]>;
