import { verificationModuleFor } from "#scripts/verify-models/registry.ts";
import { requireValue } from "#shared/required-value.ts";

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
export const cleanFacts = <Facts>(
  name: string,
): readonly [get: () => Facts, set: (facts: Facts) => void] => {
  const held: Facts[] = [];
  return [
    () =>
      requireValue(held[0], `The ${name} facts load before the first test.`),
    (facts) => {
      held[0] = facts;
    },
  ];
};
