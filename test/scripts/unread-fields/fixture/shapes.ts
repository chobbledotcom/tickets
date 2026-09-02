/**
 * The parts of the fixture repository's shape file, one module per family,
 * joined back into the single file the fixture writes. Every way a field can
 * be written down lives across these parts, so a case that needs a new shape
 * adds it to the family it is written like.
 */
import { combined } from "./shapes/combined.ts";
import { declared } from "./shapes/declared.ts";
import { members } from "./shapes/members.ts";
import { reached } from "./shapes/reached.ts";
import { references } from "./shapes/references.ts";

export const SHAPES = declared + combined + members + reached + references;
