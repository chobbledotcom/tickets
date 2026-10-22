// jscpd:ignore-start

import { Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  A_MADE_UP_CODE,
  aMadeUpCode,
  askForAMadeUpCode,
  askForTicketCode,
  headingForTickets,
  linkInTheirHand,
  openTicket,
  theWaitPasses,
} from "#test/specs/support/tickets.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

/** The steps for the rules about repeated guessing: the made-up codes a story
 * tries, the real ticket that clears the count, the refusals the site answers
 * with, and the wait that ends them. */

/** Try made-up ticket codes one after another, starting at `first`, and keep
 * what the site answered on the last try. The guessing count grows only on
 * codes nobody has tried before, so a later batch must start after the codes
 * an earlier batch tried. */
const triesMadeUpTicketCodes = async (
  world: TicketsWorld,
  first: number,
  count: number,
): Promise<void> => {
  for (let tried = first; tried < first + count; tried++) {
    const { answered, said } = await askForTicketCode(aMadeUpCode(tried));
    world.firstStatus = answered;
    world.firstBody = said;
  }
};

When(
  "somebody tries {int} made-up ticket code(s) one after another",
  async function (this: TicketsWorld, count: number): Promise<void> {
    await triesMadeUpTicketCodes(this, 0, count);
    this.madeUpCodesTried = count;
  },
);

When(
  "somebody tries {int} more made-up ticket code(s) one after another",
  async function (this: TicketsWorld, count: number): Promise<void> {
    const alreadyTried = requiredWorldValue(
      this.madeUpCodesTried,
      "the made-up ticket codes already tried",
    );
    await triesMadeUpTicketCodes(this, alreadyTried, count);
    this.madeUpCodesTried = alreadyTried + count;
  },
);

When(
  "somebody opens a made-up ticket code",
  async function (this: TicketsWorld): Promise<void> {
    const { answered, said } = await askForAMadeUpCode();
    this.firstStatus = answered;
    this.firstBody = said;
  },
);

When(
  "somebody opens the same made-up ticket code {int} time(s)",
  async function (this: TicketsWorld, count: number): Promise<void> {
    for (let tried = 0; tried < count; tried++) {
      const { answered, said } = await askForTicketCode(A_MADE_UP_CODE);
      this.firstStatus = answered;
      this.firstBody = said;
    }
  },
);

When(
  "{word} asks for that ticket and gets in",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    const page = await openTicket(this);
    expect(page.pageText).toContain(headingForTickets(1));
  },
);

When("the wait passes", function (this: TicketsWorld): Promise<void> {
  return theWaitPasses();
});

Then(
  "the site tells them there is no such page",
  function (this: TicketsWorld): void {
    expect(requiredWorldValue(this.firstStatus, "what the site answered")).toBe(
      404,
    );
    expect(requiredWorldValue(this.firstBody, "what the site said")).toContain(
      t("public.not_found.heading"),
    );
  },
);

Then(
  "the site still answers there is no such page",
  function (this: TicketsWorld): void {
    expect(requiredWorldValue(this.firstStatus, "what the site answered")).toBe(
      404,
    );
  },
);

Then(
  "the site refuses them for a while",
  async function (this: TicketsWorld): Promise<void> {
    // The try that hit the limit was still answered normally: the refusal
    // begins with the next ask.
    const { answered } = await askForTicketCode(`${A_MADE_UP_CODE}-refused`);
    expect(answered).toBe(429);
  },
);

Then(
  "even {word}'s own ticket is refused for a while",
  async function (this: TicketsWorld, _who: string): Promise<void> {
    const { answered } = await askForTicketCode(linkInTheirHand(this));
    expect(answered).toBe(429);
  },
);
