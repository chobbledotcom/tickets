/**
 * A page's filter state, and the addresses that change one part of it.
 *
 * A link that spells out its own query string carries only the filters
 * whoever wrote it remembered. Declaring the parameters once, and building
 * every link from the whole state, makes a link change one filter instead of
 * replacing the set of them — so a page cannot grow a filter that some of its
 * own links silently drop.
 */

import { mapNotNullish } from "#fp";

/** One query parameter of a filter state: its name, and the value for a
 * state — or null when the state sits at the parameter's default, which keeps
 * default choices out of addresses. */
export type ParamWriter<State> = {
  readonly name: string;
  readonly value: (state: State) => string | null;
};

/** The non-default query parameters for a state, in declared order. */
export const filterParams = <State>(
  writers: readonly ParamWriter<State>[],
  state: State,
): [name: string, value: string][] =>
  mapNotNullish((writer: ParamWriter<State>): [string, string] | null => {
    const value = writer.value(state);
    return value === null ? null : [writer.name, value];
  })(writers);

/** The address for a filter state: a path, the parameters that are not at
 * their default, and the anchor the page's links land on. */
export const filterHref = <State>(
  writers: readonly ParamWriter<State>[],
  path: string,
  state: State,
  hash = "",
): string => {
  const query = new URLSearchParams(filterParams(writers, state)).toString();
  return `${path}${query === "" ? "" : `?${query}`}${hash}`;
};
