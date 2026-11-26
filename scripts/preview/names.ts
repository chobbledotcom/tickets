// effects: pure
/** The names of one branch's preview site on the staging Bunny account. */

/** Every preview script name starts with this text. A delete only touches a
 * script whose name starts with it. */
export const SCRIPT_NAME_PREFIX = "Tickets - preview-";

const DATABASE_NAME_PREFIX = "preview-";
const SLUG_LENGTH = 30;
const HASH_LENGTH = 6;

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

/** The first hex characters of the SHA-256 of the exact branch name. Two
 * branches that give one slug still get two names. */
const hashOf = async (branch: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(branch),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, HASH_LENGTH);
};

/** The script name and the database name for one branch. */
export const previewNames = async (branch: string): Promise<PreviewNames> => {
  const identity = [slugOf(branch), await hashOf(branch)]
    .filter((part) => part !== "")
    .join("-");
  return {
    databaseName: `${DATABASE_NAME_PREFIX}${identity}`,
    scriptName: `${SCRIPT_NAME_PREFIX}${identity}`,
  };
};
