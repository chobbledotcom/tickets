/**
 * The shape of the app prefix declaration, and the fold that turns it into
 * the maps the app reads.
 */

/* jscpd:ignore-start -- imports */

import type { MessageGroup } from "#locales/manifest.ts";
import type { PathMethodRoute } from "#routes/types.ts";

/* jscpd:ignore-end */

/** A gate answers before a prefix's message groups load. */
export type PrefixGate = (path: string, method: string) => Response | null;

/** One path prefix: how it is served, the copy it renders, any gate that
 * answers before that copy loads, and the settings it reads. */
export type PrefixSpec = {
  /** The route that serves the prefix. A prefix without one serves no app
   * route, such as `setup`, which the setup router owns. */
  handler?: PathMethodRoute;
  /** The message-group bundle the prefix's handlers render. */
  messageGroups?: readonly MessageGroup[];
  /** A gate that can answer before the message groups load, such as a GET
   * redirect to login while the public site is off. */
  gate?: PrefixGate;
  /** Every route under the prefix answers GET only, proven by that prefix's
   * own route table. A false entry answers real requests with a 404. Leave
   * the flag out when unsure: a missing flag only loses the fast 404. */
  getOnly?: boolean;
  /** The settings keys the prefix reads beyond `INFRA_SETTINGS`. An empty
   * list means infra is enough: binary and JSON routes, and pure redirects
   * whose only HTML is the themed error fallback. */
  settings: readonly string[];
};

/** What a prefix serves once the declaration is folded. */
export type PrefixRoute = {
  beforeMessages: PrefixGate;
  getOnly: boolean;
  handler: PathMethodRoute;
  messageGroups: readonly MessageGroup[];
};

/** The maps every consumer reads, derived from the one declaration. */
type FoldedPrefixes = {
  routes: Record<string, PrefixRoute>;
  settings: Record<string, readonly string[]>;
};

const continueRoute: PrefixGate = () => null;

const prefixRoute = (
  spec: PrefixSpec & { handler: PathMethodRoute },
): PrefixRoute => ({
  beforeMessages: spec.gate ?? continueRoute,
  getOnly: spec.getOnly ?? false,
  handler: spec.handler,
  messageGroups: spec.messageGroups ?? [],
});

/**
 * Fold the declaration into the maps consumers read: the route each prefix
 * serves, and the settings keys it reads. Runs once at module load over pure
 * data.
 */
export const foldPrefixes = (
  specs: Readonly<Record<string, PrefixSpec>>,
): FoldedPrefixes => {
  const routes: Record<string, PrefixRoute> = {};
  const settings: Record<string, readonly string[]> = {};
  for (const [prefix, spec] of Object.entries(specs)) {
    settings[prefix] = spec.settings;
    if (spec.handler !== undefined) {
      routes[prefix] = prefixRoute({ ...spec, handler: spec.handler });
    }
  }
  return { routes, settings };
};
