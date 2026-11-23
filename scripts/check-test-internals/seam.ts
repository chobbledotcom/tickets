/**
 * The edge between tests and `src/`, as data.
 *
 * A test may import a seam module freely. The seam holds only what a person
 * outside the app also has: the HTTP handler that the server calls, and the
 * message catalog that the pages print. A database module is not on the list,
 * because a person outside the app cannot read the database.
 */

/** The `src/` modules that every test may import. */
/* jscpd:ignore-start -- a list of strings, not code */
export const SEAM_MODULES: readonly string[] = [
  "src/features/app/request.ts",
  "src/shared/i18n.ts",
];
/* jscpd:ignore-end */

/** The tree where no test may import a counted module, and where the
 * registry holds no entry. */
export const BLACKBOX_DIR = "test/blackbox/";

/** The test trees that test tooling and live providers, not the app. */
/* jscpd:ignore-start -- a list of strings, not code */
export const SKIPPED_TREES: readonly string[] = [
  "test/scripts/",
  "test/e2e-payments/",
];
/* jscpd:ignore-end */
