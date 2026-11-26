// effects: pure
/** The names of one branch's preview site on the staging Bunny account. */

/** Every preview script name starts with this text. A delete only touches a
 * script whose name starts with it. */
export const SCRIPT_NAME_PREFIX = "Tickets - preview-";

/** Bunny allows 16 characters at most in a database name. The name holds the
 * prefix and a longer hash, and no slug. */
const DATABASE_NAME_PREFIX = "pv-";
const DATABASE_HASH_LENGTH = 12;
const SLUG_LENGTH = 30;
const SCRIPT_HASH_LENGTH = 6;

export type PreviewNames = {
  databaseName: string;
  scriptName: string;
};

/** The branch name in lower case, with each run of other characters turned
 * into one dash, cut to a fixed length. */
const slugOf = (branch: string): string =>
  branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_LENGTH)
    .replace(/^-+|-+$/g, "");

/** The hex SHA-256 of the exact branch name. Two branches that give one slug
 * still get two names. */
const hashOf = async (branch: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(branch),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

/** The script name and the database name for one branch. */
export const previewNames = async (branch: string): Promise<PreviewNames> => {
  const hash = await hashOf(branch);
  const scriptIdentity = [slugOf(branch), hash.slice(0, SCRIPT_HASH_LENGTH)]
    .filter((part) => part !== "")
    .join("-");
  return {
    databaseName: `${DATABASE_NAME_PREFIX}${hash.slice(0, DATABASE_HASH_LENGTH)}`,
    scriptName: `${SCRIPT_NAME_PREFIX}${scriptIdentity}`,
  };
};
