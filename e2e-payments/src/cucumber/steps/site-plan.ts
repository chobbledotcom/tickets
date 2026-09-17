import { Then, When } from "@cucumber/cucumber";
import { catalogWords } from "#e2e/catalog-words.ts";
import { config } from "#e2e/config.ts";
import { payStripeWithHeldReturn } from "#e2e/cucumber/steps/booking.ts";
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";
import { submitBooking, waitForHostedCheckout } from "#e2e/flow.ts";
import { ErrorCode, errorCodeLabel } from "#shared/logger.ts";

/** The detail the app writes on the log's lost-assignment entry, shared with
 * the reporting line in src/shared/webhook/delivery.ts. */
const LOST_ASSIGNMENT_DETAIL =
  "Site assignment failed after a completed booking";

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
          `"${numberOfMonths}" and "${threeUnitsBuy}"); got:\n${body.slice(0, 600)}`,
      );
    }
    this.recordPhase("plan-prices-in-months");
    await submitBooking(buyer, this.bookingPath, this.scenario.booker, "3");
    await waitForHostedCheckout(buyer);
    await payStripeWithHeldReturn(this);
  },
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
  "the owner's log records the lost site assignment",
  async function (this: LiveWorld): Promise<void> {
    // The sandbox has no build infrastructure, so the plan's post-payment
    // build dies. The booking and its money stand; the lost site, its month,
    // and its setup email are the outcome that must not vanish silently, so
    // the owner's log must carry the incident that names it. A CDN request
    // failure instead means the release download failed before the build
    // began and took the pre-recorded path.
    await expectIncidentRecorded(
      this,
      `${errorCodeLabel[ErrorCode.SITE_ASSIGNMENT]} (${LOST_ASSIGNMENT_DETAIL})`,
      "lost-assignment-missing-from-log",
      "the owner's log must record the plan's lost site assignment — the " +
        "buyer paid and the booking stands, so without this entry nothing " +
        "tells the operator to repair the site by hand",
    );
  },
);

/** The dry-run build's synthesized site address, as the built-sites page
 * shows it (see src/shared/builder-dry-run.ts). */
const DRY_RUN_SITE_MARKER = ".invalid";

Then(
  "the owner's built-sites page shows the assigned site with its credit",
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
      body.includes(DRY_RUN_SITE_MARKER) &&
      body.includes(assignedPrefix) &&
      creditLabels.some((label) => body.includes(label));
    if (!shows) {
      await owner.dumpPage("dry-run-site-missing-from-built-sites");
      throw new Error(
        "the built-sites page must show the dry-run site assigned with its " +
          `credit (expected "${DRY_RUN_SITE_MARKER}", "${assignedPrefix}", ` +
          `and one of ${JSON.stringify(creditLabels)}); got:\n${body.slice(
            0,
            600,
          )}`,
      );
    }
    this.recordPhase("dry-run-site-assigned");
  },
);

Then(
  "the owner's log records no lost site assignment",
  async function (this: LiveWorld): Promise<void> {
    // With the build's provider calls answered from canned bodies, the
    // assignment must complete inside the request's subrequest budget. A
    // build that ran out of calls would land on the log as the incident this
    // step forbids — its message names the counts and the blocked call.
    await expectIncidentAbsent(
      this,
      errorCodeLabel[ErrorCode.SITE_ASSIGNMENT],
      "dry-run-incident-on-log",
      "the dry-run plan purchase must lose no site assignment, but the " +
        "owner's log carries the incident",
    );
  },
);
