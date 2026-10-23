/** A pure-listed module that reaches the database root only through a
 * dynamic import. */
export const late = async (): Promise<string> =>
  (await import("../io/store.ts")).write();
