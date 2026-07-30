/**
 * The one place a story keeps what it named, and the one place it says what to
 * put back. Both are leaned on by every story, so a fault here would show up as
 * a puzzling failure somewhere else — these check them directly.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  namedThings,
  type PutsThingsBack,
  putsThingsBack,
} from "#test/specs/support/memory.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

// jscpd:ignore-end

describe("what a story remembers", () => {
  test("hands back the thing it was given, so setting up and keeping is one step", () => {
    const things = namedThings();
    const browser = new TestBrowser();
    expect(things.remember("browser", "the customer", browser)).toBe(browser);
  });

  test("gives back what was kept under a name", () => {
    const things = namedThings();
    things.remember("ticket", "Ada", "abc123");
    expect(things.require("ticket", "Ada")).toBe("abc123");
  });

  test("keeps each kind apart, so one name can mean two things", () => {
    const things = namedThings();
    things.remember("ticket", "Pottery", "abc123");
    things.remember("key", "Pottery", "sk_live");
    expect(things.require("ticket", "Pottery")).toBe("abc123");
    expect(things.require("key", "Pottery")).toBe("sk_live");
  });

  test("says nothing was kept, rather than failing, when only asked", () => {
    expect(namedThings().recall("listing", "the Pottery")).toBeUndefined();
  });

  test("names the kind and the name when the story never set one up", () => {
    expect(() => namedThings().require("bundle", "the Weekend")).toThrow(
      'The story never set up the bundle "the Weekend"',
    );
  });

  test("makes a thing the first time it is asked for", () => {
    const things = namedThings();
    const made = things.orMake(
      "browser",
      "the editor",
      () => new TestBrowser(),
    );
    expect(things.require("browser", "the editor")).toBe(made);
  });

  test("makes it only once, so later asks get the same one", () => {
    const things = namedThings();
    let made = 0;
    const makeOne = () => {
      made += 1;
      return new TestBrowser();
    };
    const first = things.orMake("browser", "the editor", makeOne);
    expect(things.orMake("browser", "the editor", makeOne)).toBe(first);
    expect(made).toBe(1);
  });

  test("forgets one name, so the next ask starts again", () => {
    const things = namedThings();
    const first = things.orMake(
      "browser",
      "the organiser",
      () => new TestBrowser(),
    );
    things.forget("browser", "the organiser");
    expect(
      things.orMake("browser", "the organiser", () => new TestBrowser()),
    ).not.toBe(first);
  });

  test("lists the names one kind holds, in the order they were first used", () => {
    const things = namedThings();
    things.remember("daysOffered", "the Weekend", ["2026-01-01"]);
    things.remember("ticket", "Ada", "abc123");
    things.remember("daysOffered", "the Pottery", ["2026-01-02"]);
    expect(things.names("daysOffered")).toEqual(["the Weekend", "the Pottery"]);
  });

  test("lists nothing for a kind the story never used", () => {
    expect(namedThings().names("key")).toEqual([]);
  });
});

describe("what a story puts back", () => {
  /** What one story's put-backs did, in the order they really ran, and
   * whatever they raised. Every check here is the same three steps: say what
   * to put back, run them all, read what happened. */
  const whatHappened = async (
    sayWhatToPutBack: (
      cleanup: PutsThingsBack,
      note: (what: string) => () => void,
    ) => void,
  ): Promise<{ done: string[]; raised: unknown }> => {
    const done: string[] = [];
    const cleanup = putsThingsBack();
    sayWhatToPutBack(cleanup, (what) => () => {
      done.push(what);
    });
    try {
      await cleanup.runAll();
      return { done, raised: null };
    } catch (raised) {
      return { done, raised };
    }
  };

  /** Each way a story can say what to put back, and what running them all
   * should have done. */
  const PUT_BACKS: Array<{
    does: string;
    ran: string[];
    say: (cleanup: PutsThingsBack, note: (what: string) => () => void) => void;
  }> = [
    {
      does: "runs a task it was given",
      ran: ["first"],
      say: (cleanup, note) => cleanup.add(note("first")),
    },
    {
      does: "puts back what was changed last, first",
      ran: ["third", "second", "first"],
      say: (cleanup, note) => {
        cleanup.add(note("first"), note("second"));
        cleanup.add(note("third"));
      },
    },
    {
      does: "throws away anything that tidies itself up",
      ran: ["disposed"],
      say: (cleanup, note) =>
        cleanup.add({ [Symbol.dispose]: note("disposed") }),
    },
    {
      does: "waits for a task that takes a moment",
      ran: ["later"],
      say: (cleanup, note) =>
        cleanup.add(async () => {
          await Promise.resolve();
          note("later")();
        }),
    },
  ];

  for (const { does, ran, say } of PUT_BACKS) {
    test(does, async () => {
      expect((await whatHappened(say)).done).toEqual(ran);
    });
  }

  test("reports a task that failed, having still run the rest", async () => {
    const failed = new Error("could not put it back");
    const { done, raised } = await whatHappened((cleanup, note) => {
      cleanup.add(note("ran anyway"));
      cleanup.add(() => {
        throw failed;
      });
    });
    expect(raised).toBe(failed);
    expect(done).toEqual(["ran anyway"]);
  });
});
