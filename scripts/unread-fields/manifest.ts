/** The checked-in registries of the gate. Each one is a JSON manifest: every
 *  production source file, with the entries it holds for its owner paths. The
 *  gate reads both registries through this one reader. */

import * as v from "valibot";
import { parseOrThrow } from "#shared/validation/parse.ts";

/** A step is a field's name or the way a reader reaches through a member with
 *  no name. Both carry exactly one of the two words. */
const stepSchema = v.union(
  [v.strictObject({ name: v.string() }), v.strictObject({ way: v.string() })],
  "A step must name a field or the way a reader reaches through it",
);

/** The owner path of one entry: the exported shape, then each step a reader
 *  takes from it. */
export const ownerPathSchema = (entry: string) =>
  v.pipe(
    v.array(stepSchema),
    v.nonEmpty(`A ${entry} must name at least one owner path step`),
  );

/** Where in the manifest an issue sits, so a reader can go to it. */
const issuePlace = (issue: v.BaseIssue<unknown>): string => {
  const place = (issue.path ?? []).map((item) => String(item.key)).join(" / ");
  return place === "" ? "the top of the manifest" : place;
};

/** The reader of one manifest. Each entry becomes the records the gate uses,
 *  built from the entry and the file that exports its owner. A malformed
 *  manifest fails here, before the scan, and names the entry to repair. */
export const manifestReader = <Entry, Held>(
  manifest: string,
  entry: string,
  entrySchema: v.GenericSchema<unknown, Entry>,
  recordsOf: (exportedFrom: string, entry: Entry) => Held[],
): ((input: unknown) => Held[]) => {
  const schema = v.record(
    v.pipe(
      v.string(),
      v.startsWith("src/", `A ${manifest} file must be a path under src/`),
    ),
    v.pipe(
      v.array(entrySchema),
      v.nonEmpty(`A file must name at least one ${entry}`),
    ),
  );
  const invalid = (issues: readonly v.BaseIssue<unknown>[]): Error =>
    new Error(
      [
        `The unread-field ${manifest} manifest is not valid:`,
        ...issues.map((issue) => `  ${issuePlace(issue)}: ${issue.message}`),
      ].join("\n"),
    );
  return (input) =>
    Object.entries(parseOrThrow(schema, input, invalid)).flatMap(
      ([exportedFrom, entries]) =>
        entries.flatMap((held) => recordsOf(exportedFrom, held)),
    );
};
