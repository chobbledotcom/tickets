/**
 * Every path prefix the app layer serves, in one declaration.
 *
 * A prefix names the route that serves it, the message groups its handlers
 * render, any gate that answers first, and the settings it reads beyond
 * `INFRA_SETTINGS`. The declarations themselves live in the two alphabetical
 * halves beside this file. Join a new prefix to the half its name sorts into.
 *
 * Import specifiers stay literal so esbuild bundles every lazy target into
 * the single edge file, and defers evaluation until the first match. A
 * loader shared by two prefixes is named so both reuse one cached import.
 */

import {
  foldPrefixes,
  type PrefixRoute,
  type PrefixSpec,
} from "./prefix-fold.ts";
import { PREFIXES_A_L } from "./prefixes-a-l.ts";
import { PREFIXES_M_Z } from "./prefixes-m-z.ts";

const APP_PREFIXES = {
  ...PREFIXES_A_L,
  ...PREFIXES_M_Z,
} satisfies Record<string, PrefixSpec>;

const folded = foldPrefixes(APP_PREFIXES);

/** The route each prefix serves, by prefix. A prefix with no handler serves
 * none. */
export const prefixRoutes: Record<string, PrefixRoute> = folded.routes;

/** The settings keys each prefix reads beyond `INFRA_SETTINGS`, by prefix. */
export const prefixSettings: Record<string, readonly string[]> =
  folded.settings;
