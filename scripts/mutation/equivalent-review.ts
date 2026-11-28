import { shortHash } from "#scripts/checksum.ts";
import {
  type RegistryScope,
  type ResolvedEntry,
  readEquivalentRegistry,
  registryEntryId,
  registryRewrites,
} from "./equivalent-registry.ts";
import { withCopyBackLock } from "./isolation-lock.ts";
import { writeCheckedFiles } from "./snapshot-copy-back.ts";

export interface ProofReview {
  excerpt: string;
  key: string;
  location: string;
  reason: string;
  stamp: string;
  token: string;
}

const sha256 = async (text: string): Promise<string> => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return new Uint8Array(digest).toHex();
};

const excerptFor = ({ original, mutant }: ResolvedEntry): string => {
  const start = original.lastIndexOf("\n", mutant.start - 1) + 1;
  const end = original.indexOf("\n", mutant.end);
  return original.slice(start, end < 0 ? original.length : end).trim();
};

export const proofReviews = () => {
  const stamps = new Map<string, string>();
  const revisions = new Map<string, Promise<string>>();
  return async (entry: ResolvedEntry): Promise<ProofReview | null> => {
    let stamp = stamps.get(entry.file);
    if (stamp === undefined) {
      stamp = `audited:${shortHash(entry.original)}`;
      stamps.set(entry.file, stamp);
    }
    if (entry.stamp === stamp) return null;
    let revision = revisions.get(entry.file);
    if (revision === undefined) {
      revision = sha256(entry.original);
      revisions.set(entry.file, revision);
    }
    const { column, line } = entry.mutant;
    return {
      excerpt: excerptFor(entry),
      key: entry.key,
      location: `${entry.sourcePath}:${line}:${column}`,
      reason: entry.reason,
      stamp,
      token: await sha256(JSON.stringify([await revision, entry.chunk])),
    };
  };
};

const renewedChunk = (entry: ResolvedEntry, stamp: string): string => {
  const comment = entry.line.indexOf("#");
  const at = entry.line.lastIndexOf(
    entry.stamp,
    comment < 0 ? entry.line.length : comment,
  );
  return (
    entry.chunk.slice(0, at) +
    stamp +
    entry.chunk.slice(at + entry.stamp.length)
  );
};

/** Accept only the source revision and registry line that the reviewer saw. */
export const renewEquivalentMutants = async (
  scope: RegistryScope,
  tokens: readonly string[],
): Promise<number> =>
  await withCopyBackLock(scope.root, async () => {
    const { registries, resolved } = await readEquivalentRegistry(scope);
    const pending = new Set(tokens);
    const replacements = new Map<string, string>();
    const originals = new Map<string, string>();
    const reviewEntry = proofReviews();
    for (const entry of resolved) {
      if (pending.size === 0) break;
      const review = await reviewEntry(entry);
      if (review === null || !pending.delete(review.token)) continue;
      replacements.set(
        registryEntryId(entry),
        renewedChunk(entry, review.stamp),
      );
      originals.set(entry.file, entry.original);
    }
    if (pending.size > 0) {
      throw new Error(
        `Renewal tokens do not match the current source and registry: ${[...pending].join(", ")}. Run the audit again.`,
      );
    }
    const changes = registryRewrites(registries, replacements);
    const verifySources = async () => {
      for (const [file, original] of originals) {
        if ((await Deno.readTextFile(file)) !== original) {
          throw new Error(
            `${file} changed during renewal. Run the audit again.`,
          );
        }
      }
    };
    await writeCheckedFiles(scope.root, changes, (entry) => entry.after, {
      verify: verifySources,
    });
    return replacements.size;
  });
