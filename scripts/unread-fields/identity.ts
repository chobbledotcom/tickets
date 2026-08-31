import { type Step, stepText } from "#scripts/unread-fields/fields/steps.ts";

/** The stable facts that name one field under one exported shape. */
export interface FindingIdentity {
  exportedFrom: string;
  field: string;
  path: readonly Step[];
}

const stepKey = (step: Step): readonly ["name" | "way", string] =>
  "name" in step ? ["name", step.name] : ["way", step.way];

/** The machine key for one field. Tagged steps keep a name such as `[]`
 * separate from the unnamed route through an array element. */
export const findingIdentityKey = (identity: FindingIdentity): string =>
  JSON.stringify([
    identity.exportedFrom,
    identity.path.map(stepKey),
    identity.field,
  ]);

/** A stable code-unit order for machine identities and paths. */
export const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** A stable order for policy and diagnostic output. */
export const compareFindingIdentities = (
  left: FindingIdentity,
  right: FindingIdentity,
): number => {
  const leftKey = findingIdentityKey(left);
  const rightKey = findingIdentityKey(right);
  return compareText(leftKey, rightKey);
};

const plainWord = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** How a reader reaches one more name from an existing path. */
export const reaching = (path: string, name: string): string =>
  plainWord.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;

/** The readable path to the owner of a field. */
export const ownerPath = (owner: readonly Step[]): string => {
  const [first, ...rest] = owner;
  if (first === undefined) throw new Error("An unread field has no owner");
  return rest.reduce(
    (path, step) => reaching(path, stepText(step)),
    stepText(first),
  );
};

/** The field path as code reaches it. */
export const findingPath = (identity: FindingIdentity): string =>
  reaching(ownerPath(identity.path), identity.field);

/** The exact identity in a diagnostic. Step tags make collisions visible. */
export const findingIdentityText = (identity: FindingIdentity): string =>
  `${identity.exportedFrom} :: ${[
    ...identity.path.map((step) =>
      "name" in step
        ? `name(${JSON.stringify(step.name)})`
        : `way(${JSON.stringify(step.way)})`,
    ),
    `name(${JSON.stringify(identity.field)})`,
  ].join(" / ")}`;

type FindingOwner = readonly [exportedFrom: string, path: readonly Step[]];

/** Build exact identities for fields under one or more exported owners. */
export const identitiesAt =
  (
    owners: readonly FindingOwner[],
  ): ((fields: readonly string[]) => FindingIdentity[]) =>
  (fields) =>
    owners.flatMap(([exportedFrom, path]) =>
      fields.map((field) => ({ exportedFrom, field, path: [...path] })),
    );
