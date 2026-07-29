// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { t } from "#i18n";
import {
  askedForOwnerPage,
  askedWhatIsSold,
  expectToldAbout,
  keyNamed,
  keysPageResponse,
  keysPageText,
  ownerMakesKey,
  ownerOpensKeys,
  ownerTakesBackKey,
} from "#test/specs/support/api-keys.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";

// jscpd:ignore-end

Given(
  "the owner is looking at their keys",
  function (this: TicketsWorld): Promise<void> {
    return ownerOpensKeys(this);
  },
);

/** Making a key, however the story words it — one story makes it as the thing
 * it is testing, the others only need one to exist first. */
const makesKey = function (this: TicketsWorld, name: string): Promise<void> {
  return ownerMakesKey(this, name);
};

When("the owner makes a key called {word}", makesKey);
Given("the owner has a key called {word}", makesKey);

Then(
  "the owner is shown the key itself, and told to copy it now",
  function (this: TicketsWorld): void {
    const shown = requiredWorldValue(
      this.apiKeyShownOnce,
      "what the owner was shown",
    );
    expect(shown).toContain(t("api_keys.copy_notice"));
    // The words alone are not the key. The page has to carry the real one, or
    // the owner has nothing to hand on.
    expect(shown).toContain(keyNamed(this, "Shopfront"));
  },
);

Then(
  "the list of keys names {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    expect(await keysPageText(this)).toContain(name);
  },
);

Then(
  "the list of keys never shows the key itself",
  async function (this: TicketsWorld): Promise<void> {
    // The whole response, not only its visible words: a key in a link or a
    // hidden box is one anybody reading the page can still use.
    expect(await keysPageResponse(this)).not.toContain(
      keyNamed(this, "Shopfront"),
    );
  },
);

Then(
  "the list of keys is empty",
  async function (this: TicketsWorld): Promise<void> {
    expect(await keysPageText(this)).not.toContain("Shopfront");
  },
);

/** What the site answered the last time something asked what is on sale. */
const asked = async (
  world: TicketsWorld,
  carrying: string | null,
): Promise<{ answered: number; said: string }> => {
  const answer = await askedWhatIsSold(carrying);
  world.apiKeyAnswer = answer;
  return answer;
};

When(
  "{word} asks the site what it sells",
  async function (this: TicketsWorld, who: string): Promise<void> {
    await asked(this, keyNamed(this, who));
  },
);

When(
  "something asks the site what it sells, carrying nothing",
  async function (this: TicketsWorld): Promise<void> {
    await asked(this, null);
  },
);

When(
  "something asks the site what it sells, carrying a made-up key",
  async function (this: TicketsWorld): Promise<void> {
    await asked(this, "not-a-real-key");
  },
);

/** What the site answered, however the story got there. */
const theAnswer = (world: TicketsWorld) =>
  requiredWorldValue(world.apiKeyAnswer, "what the site answered");

/** Being told about something, whether the story asked just now or earlier. */
const expectToldAboutThing = async function (
  this: TicketsWorld,
  who: string,
  name: string,
): Promise<void> {
  const { answered, said } = await asked(this, keyNamed(this, who));
  expect(answered).toBe(200);
  expectToldAbout(said, name);
};

Then("{word} is told about the {word}", expectToldAboutThing);

Then(
  "the request is refused as unauthorised",
  function (this: TicketsWorld): void {
    expect(theAnswer(this).answered).toBe(401);
  },
);

Then(
  "{word} is refused as unauthorised",
  async function (this: TicketsWorld, who: string): Promise<void> {
    const { answered } = await asked(this, keyNamed(this, who));
    expect(answered).toBe(401);
  },
);

When(
  "{word} asks for the owner's {string} page",
  async function (
    this: TicketsWorld,
    who: string,
    page: string,
  ): Promise<void> {
    this.apiKeyPageAnswer = await askedForOwnerPage(keyNamed(this, who), page);
  },
);

Then("{word} is not let in", function (this: TicketsWorld, _who: string): void {
  // Sent to sign in, which is what the site does with anyone it does not know
  // — the key buys nothing here.
  expect(
    requiredWorldValue(this.apiKeyPageAnswer, "what the page answered"),
  ).toBe(302);
});

When(
  "the owner takes back the key called {word}",
  async function (this: TicketsWorld, name: string): Promise<void> {
    this.apiKeyTakeBack = await ownerTakesBackKey(this, name, name);
  },
);

When(
  "the owner tries to take back {word} by typing {word}",
  async function (
    this: TicketsWorld,
    name: string,
    typed: string,
  ): Promise<void> {
    this.apiKeyTakeBack = await ownerTakesBackKey(this, name, typed);
  },
);

Then(
  "the owner is told the name does not match",
  function (this: TicketsWorld): void {
    expect(
      requiredWorldValue(this.apiKeyTakeBack, "what the owner was told"),
    ).toContain("does not match");
  },
);
