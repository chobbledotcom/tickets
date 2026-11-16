import { lazyRef } from "#fp";
import { verificationModuleFor } from "#scripts/verify-models/registry.ts";

/** Resolve the same lazy facts consumed by the model checker. */
export const registeredModel = (module: string) => {
  const declaration = verificationModuleFor(`verification/${module}.tla`);
  if (declaration.kind !== "model") {
    throw new Error(`${module} declares no model facts`);
  }
  return declaration;
};

/** One clean producer run serves every test of a file. The file fills the
 * value in `beforeAll`. A read before that is an error. */
export const cleanFacts = <Facts>(name: string) =>
  lazyRef<Facts>(() => {
    throw new Error(`The ${name} facts load before the first test.`);
  });
