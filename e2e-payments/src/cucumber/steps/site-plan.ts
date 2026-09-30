import { Given, Then, When } from "@cucumber/cucumber";
import { catalogWords } from "#e2e/catalog-words.ts";
import { config } from "#e2e/config.ts";
import { payStripeWithHeldReturn } from "#e2e/cucumber/steps/booking.ts";
import { type LiveWorld, worldStep } from "#e2e/cucumber/support/world.ts";
import { submitBooking, waitForHostedCheckout } from "#e2e/flow.ts";
import { step } from "#e2e/log.ts";
import { ErrorCode, errorCodeLabel } from "#shared/logger.ts";

/** The detail the app writes when the pool of assignable sites runs dry,
 * shared with the reporting line in src/shared/site-assignment-failure.ts. */
const EMPTY_POOL_DETAIL = "the pool of assignable sites is empty";

When(
  "a separate visitor pays for three units through Stripe Checkout",
  { timeout: config.hostedPaymentStepTimeoutMs },
  async function (this: LiveWorld): Promise<void> {
    // The plan's months pricing is asserted while the visitor still has the
    // page: the checkout selector names months, and each count states what
    // it buys — three units of this three-month plan read "9 months". The
    // words come from the catalog, so a rename travels with the app.
    const buyer = this.resources.visitor;
    await buyer.goto(this.bookingPath);
    const body = await buyer.bodyText();
    const numberOfMonths = await catalogWords(
      "tickets",
      "public.ticket.number_of_months",
    );
    const threeUnitsBuy = await catalogWords(
      "tickets",
      "public.ticket.month_option",
      {
        count: 9,
      },
    );
    if (!body.includes(numberOfMonths) || !body.includes(threeUnitsBuy)) {
      await buyer.dumpPage("plan-page-not-priced-in-months");
      throw new Error(
        `the plan's booking page must price it in months (expected ` +
          `"${numberOfMonths}" and "${threeUnitsBuy}"); got:\n${body.slice(
            0,
            600,
          )}`,
      );
    }
    this.recordPhase("plan-prices-in-months");
    await submitBooking(buyer, this.bookingPath, this.scenario.booker, "3");
    await waitForHostedCheckout(buyer);
    await payStripeWithHeldReturn(this);
  },
);

Given(
  "the owner has registered an assignable built site",
  worldStep(async (world) => {
    await world.prepareOwner();
    const owner = world.resources.owner;
    const site = {
      name: `E2E Pooled ${world.scenario.runId}`,
      url: `https://pooled-${world.scenario.runId}.example.test`,
    };
    step(`Registering an assignable built site (${site.url})`);
    await owner.goto("/admin/built-sites/new");
    await owner.fill("name", site.name);
    await owner.fill("site_url", site.url);
    // The purchase's renewal pushes are Bunny API calls, and this case's app
    // server answers those from canned bodies, so any hosting id reaches a
    // canned answer.
    await owner.fill("hosting_id", "42");
    await owner.check("assignable");
    await owner.clickButton(
      await catalogWords("built-sites", "built_sites.create_built_site_button"),
    );
    world.rememberPoolSite(site);
    world.recordPhase("pooled-site-registered");
  }),
);

/** The owner's admin log page, opened fresh, as text. */
const ownerLogBody = async (world: LiveWorld): Promise<string> => {
  const owner = world.resources.owner;
  await owner.goto("/admin/log");
  return await owner.bodyText();
};

/** Ask the owner's log for one piece of text, recording evidence and naming
 * the failure when it must be there or must be absent. */
const expectOnOwnerLog =
  (wanted: "recorded" | "absent") =>
  async (
    world: LiveWorld,
    text: string,
    dumpLabel: string,
    complaint: string,
  ): Promise<void> => {
    const body = await ownerLogBody(world);
    const present = body.includes(text);
    if ((wanted === "recorded") === present) return;
    await world.resources.owner.dumpPage(dumpLabel);
    throw new Error(`${complaint}; got:\n${body.slice(0, 600)}`);
  };

const expectIncidentRecorded = expectOnOwnerLog("recorded");
const expectIncidentAbsent = expectOnOwnerLog("absent");

Then(
  "the owner's log records the empty site pool",
  async function (this: LiveWorld): Promise<void> {
    // The sandbox stocks no assignable site, so the purchase can hand the
    // buyer nothing. The booking and its money stand, so the empty pool must
    // reach the operator as an incident that names it.
    await expectIncidentRecorded(
      this,
      EMPTY_POOL_DETAIL,
      "empty-pool-missing-from-log",
      "the owner's log must record the empty site pool — the buyer paid and " +
        "the booking stands, so without this entry nothing tells the operator " +
        "to stock sites and repair the buyer's booking by hand",
    );
  },
);

Then(
  "the owner's built-sites page shows the pooled site assigned with its credit",
  async function (this: LiveWorld): Promise<void> {
    // Three units of the three-month plan credit the site nine months, shown
    // as the read-only deadline. The renderer and the date arithmetic are
    // the app's own, so the same helpers state what the page must display;
    // the deadline was set when the webhook ran, so a day's rounding drift is
    // allowed on either side.
    const { addMonthsIso } = await import("#shared/dates.ts");
    const { formatDeadlineLabel } = await import("#shared/renewal-helpers.ts");
    const { DAY_MS } = await import("#shared/now.ts");
    const deadline = Date.parse(addMonthsIso(new Date().toISOString(), 9));
    const creditLabels = [DAY_MS, 0, -DAY_MS].map((shift) =>
      formatDeadlineLabel(new Date(deadline + shift).toISOString()),
    );
    const owner = this.resources.owner;
    await owner.goto("/admin/built-sites");
    const body = await owner.bodyText();
    // The label names the assigned attendee by id, so assert only the words
    // before the id: they travel with a rename, the id does not matter.
    const assignedPrefix = (
      await catalogWords("built-sites", "built_sites.status_assigned", {
        id: 0,
      })
    ).split("#")[0]!;
    const shows =
      body.includes(this.pooledSite.name) &&
      body.includes(assignedPrefix) &&
      creditLabels.some((label) => body.includes(label));
    if (!shows) {
      await owner.dumpPage("pooled-site-missing-from-built-sites");
      throw new Error(
        "the built-sites page must show the pooled site assigned with its " +
          `credit (expected "${this.pooledSite.name}", "${assignedPrefix}", ` +
          `and one of ${JSON.stringify(creditLabels)}); got:\n${body.slice(
            0,
            600,
          )}`,
      );
    }
    this.recordPhase("pooled-site-assigned");
  },
);

Then(
  "the owner's log records no lost site assignment",
  async function (this: LiveWorld): Promise<void> {
    // With the pooled site handed out and its renewal pushes answered from
    // canned bodies, the assignment must complete without an incident. An
    // assignment that failed would land on the log as this step forbids.
    await expectIncidentAbsent(
      this,
      errorCodeLabel[ErrorCode.SITE_ASSIGNMENT],
      "pooled-plan-incident-on-log",
      "the pooled plan purchase must lose no site assignment, but the " +
        "owner's log carries the incident",
    );
  },
);
