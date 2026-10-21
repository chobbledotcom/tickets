import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import {
  plantAnswersWithGoneLink,
  plantAnswersWithHeldLink,
  plantedCheckoutStates,
  plantedCheckoutsDueForRecovery,
  plantRecentAnswers,
  plantRetentionCheckouts,
  runScheduledMaintenance,
  STAGED_ANSWER_SESSIONS,
  stagedAnswerTexts,
} from "#test/specs/support/retention.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";

Given(
  "an old finished SumUp checkout, an equally old one still waiting to hear, and a recent finished one",
  function (this: TicketsWorld): Promise<void> {
    return plantRetentionCheckouts(this);
  },
);

When(
  "scheduled maintenance runs",
  function (this: TicketsWorld): Promise<void> {
    return runScheduledMaintenance(this);
  },
);

Then(
  "the old finished checkout is gone",
  async function (this: TicketsWorld): Promise<void> {
    expect((await plantedCheckoutStates()).get("old-finished")).toBeUndefined();
  },
);

Then(
  "the waiting checkout is still there, still due for its next check",
  async function (this: TicketsWorld): Promise<void> {
    expect((await plantedCheckoutStates()).get("old-waiting")).toBe("waiting");
    expect(await plantedCheckoutsDueForRecovery()).toContain(
      "prune-old-waiting",
    );
  },
);

Then(
  "the recent checkout is still there",
  async function (this: TicketsWorld): Promise<void> {
    expect((await plantedCheckoutStates()).get("recent-finished")).toBe(
      "finished",
    );
  },
);

Given(
  "an old buyer's answers for a checkout whose payment link has ended but whose link the site still holds",
  function (this: TicketsWorld): Promise<void> {
    return plantAnswersWithHeldLink(this);
  },
);

Given(
  "an equally old buyer's answers for a checkout whose link the site no longer holds",
  function (this: TicketsWorld): Promise<void> {
    return plantAnswersWithGoneLink(this);
  },
);

Given(
  "a recent buyer's answers for a checkout still inside its window",
  function (this: TicketsWorld): Promise<void> {
    return plantRecentAnswers(this);
  },
);

Then(
  "the answers the site still holds a link for are kept",
  async function (this: TicketsWorld): Promise<void> {
    const answers = await stagedAnswerTexts(STAGED_ANSWER_SESSIONS.kept);
    expect(answers.get(3)).toBe("Arriving late");
  },
);

Then(
  "the answers whose link is gone are removed",
  async function (this: TicketsWorld): Promise<void> {
    expect((await stagedAnswerTexts(STAGED_ANSWER_SESSIONS.gone)).size).toBe(0);
  },
);

Then(
  "the answers inside their window are kept",
  async function (this: TicketsWorld): Promise<void> {
    const answers = await stagedAnswerTexts(STAGED_ANSWER_SESSIONS.recent);
    expect(answers.get(3)).toBe("Two tickets");
  },
);
