/**
 * Where a screenshot's page is. A capture either has one address forever, in
 * which case its declaration says so, or the story makes the address as it
 * runs and hands it over here, named after the screenshot it is for.
 */

import * as v from "valibot";
import type { EvidenceCaptureId } from "./declarations.ts";
import {
  type EvidenceCaptureDeclaration,
  EvidencePathSchema,
} from "./schema.ts";

/** The pages a running story has left behind, one for each screenshot it is
 * setting up. */
export interface EvidencePages {
  evidencePages: Map<EvidenceCaptureId, string>;
}

/** Naming the screenshots is what ties a page to a declared capture: a name
 * nothing declares does not compile. */
export const leaveEvidencePage = (
  world: EvidencePages,
  captureIds: readonly EvidenceCaptureId[],
  path: string,
): void => {
  const address = v.parse(EvidencePathSchema, path);
  for (const captureId of captureIds)
    world.evidencePages.set(captureId, address);
};

/** The address to open for one screenshot: the one its declaration fixes, or
 * the one the story left. A screenshot with neither is a story that never
 * reached the page it promised. */
export const evidencePagePath = (
  declaration: EvidenceCaptureDeclaration,
  pages: ReadonlyMap<string, string>,
): string => {
  if (declaration.path !== undefined) return declaration.path;
  const left = pages.get(declaration.id);
  if (left === undefined) {
    throw new Error(`The story left no page for the ${declaration.id} capture`);
  }
  return left;
};
