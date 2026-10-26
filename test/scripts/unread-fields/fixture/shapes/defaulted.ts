/**
 * The part of the fixture's shape file whose class the module exports with
 * no name. A module holds one default export, so the class the scan must
 * report as unread lives in its own file, which the build writes beside it.
 */
export const defaulted = `
// The base the default class borrows its fields from. The file does not
// export it, so the walk meets its members only through the class below.
class BehindTheDefault {
  onTheBase = 1;
  static carriedToTheDefault = 1;
}

export default class extends BehindTheDefault {
  handedOver = 1;
  static carriedOnTheClass = 1;
}
`;

/** The whole file `src/defaulted.ts` holds: one anonymous default class whose
 * field nothing reads. */
export const alone = `export default class {
  silent = 1;
}
`;
