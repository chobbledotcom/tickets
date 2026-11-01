import { verificationModuleFor } from "#scripts/verify-models/registry.ts";

/** Resolve the same lazy facts consumed by the model checker. */
export const registeredModel = (module: string) => {
  const declaration = verificationModuleFor(`verification/${module}.tla`);
  if (declaration.kind !== "model") {
    throw new Error(`${module} declares no model facts`);
  }
  return declaration;
};
