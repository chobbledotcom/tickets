/**
 * The part of the fixture's shape file whose class the module exports with
 * no name. A module holds one default export, so the class the scan must
 * report as unread lives in its own file, which the build writes beside it.
 */
export const defaulted = `
export default class extends BaseClass {
  static heldByTheUnnamed = 1;
  handedOver = 1;
}
`;

/** The whole file `src/defaulted.ts` holds: one anonymous default class whose
 * field nothing reads. */
export const alone = `export default class {
  silent = 1;
}
`;
