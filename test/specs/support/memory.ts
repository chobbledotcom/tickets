/**
 * What a story remembers while it runs, and what it puts back at the end.
 *
 * Stories give the things they set up names of their own ("the Pottery", "the
 * editor", "Ada's ticket"). Rather than a field per kind of thing, everything
 * named is kept in one store, split by what kind of thing the name holds. The
 * kind decides the type, so asking for a listing can never hand back a browser,
 * and a new story adds a name instead of a new world field.
 */

// jscpd:ignore-start
import { type CleanupTask, runCleanups } from "#scripts/cleanup.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { Group, Listing } from "#types";
// jscpd:ignore-end

/** Every kind of thing a story can keep by name, and what each name holds. */
export interface ThingsByKind {
  /** The addresses of the people a story booked onto one listing, in the order
   * it booked them. */
  booked: string[];
  /** Somebody's own window on the site: the organiser's, a customer's. */
  browser: TestBrowser;
  /** Things sold together under one name. */
  bundle: Group;
  /** The days a listing's own page offered, the last time it was looked at. */
  daysOffered: string[];
  /** A key the owner made for another system, as it was handed to them once. */
  key: string;
  /** Something the site sells. */
  listing: Listing;
  /** The number the site filed something under, kept by the story's name
   * for it — a news post, a holiday, anything made through a form. */
  record: number;
  /** The code one person holds to get in. */
  ticket: string;
  /** What somebody was told the last time they did something. */
  told: string;
}

export type ThingKind = keyof ThingsByKind;

export interface RemembersThings {
  /** Forget the thing under this name, so the next ask starts again. */
  forget(kind: ThingKind, name: string): void;
  /** Every name the story has used for this kind of thing, in the order it
   * first used them. */
  names(kind: ThingKind): string[];
  /** The thing under this name, made and kept the first time it is asked for. */
  orMake<Kind extends ThingKind>(
    kind: Kind,
    name: string,
    make: () => ThingsByKind[Kind],
  ): ThingsByKind[Kind];
  /** The thing under this name, or nothing when the story never set one up. */
  recall<Kind extends ThingKind>(
    kind: Kind,
    name: string,
  ): ThingsByKind[Kind] | undefined;
  /** Keep a thing under the name the story calls it, and hand it straight
   * back, so setting one up and remembering it is one step. */
  remember<Kind extends ThingKind>(
    kind: Kind,
    name: string,
    thing: ThingsByKind[Kind],
  ): ThingsByKind[Kind];
  /** The thing under this name, or a loud failure. A story that carried on
   * without it would report the site's behaviour when the fault is its own. */
  require<Kind extends ThingKind>(kind: Kind, name: string): ThingsByKind[Kind];
}

/** One store for every named thing, so two kinds can share a name without
 * treading on each other. */
export const namedThings = (): RemembersThings => {
  const kept = new Map<string, unknown>();
  const under = (kind: ThingKind, name: string): string => `${kind}: ${name}`;
  const store: RemembersThings = {
    forget: (kind, name) => {
      kept.delete(under(kind, name));
    },
    names: (kind) =>
      [...kept.keys()]
        .filter((key) => key.startsWith(`${kind}: `))
        .map((key) => key.slice(kind.length + 2)),
    orMake: (kind, name, make) =>
      store.recall(kind, name) ?? store.remember(kind, name, make()),
    recall: <Kind extends ThingKind>(kind: Kind, name: string) =>
      kept.get(under(kind, name)) as ThingsByKind[Kind] | undefined,
    remember: (kind, name, thing) => {
      kept.set(under(kind, name), thing);
      return thing;
    },
    require: <Kind extends ThingKind>(kind: Kind, name: string) => {
      const thing = store.recall(kind, name);
      if (thing === undefined) {
        throw new Error(`The story never set up the ${kind} "${name}"`);
      }
      return thing;
    },
  };
  return store;
};

/** Something to undo when the story ends: a task to run, or anything that puts
 * itself back when it is thrown away — a scoped environment, say. */
export type Undoable = CleanupTask | Disposable;

const asTask = (undo: Undoable): CleanupTask =>
  typeof undo === "function" ? undo : () => undo[Symbol.dispose]();

export interface PutsThingsBack {
  add(...undo: Undoable[]): void;
  runAll(): Promise<void>;
}

/** Whatever a story changed outside itself, put back in the opposite order it
 * was changed, so one story's stand-in cannot leak into the next. */
export const putsThingsBack = (): PutsThingsBack => {
  const undo: CleanupTask[] = [];
  return {
    add: (...added) => {
      undo.push(...added.map(asTask));
    },
    runAll: () => runCleanups(undo.toReversed()),
  };
};
