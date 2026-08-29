/**
 * Owner-page navigation and page-fact gathering shared by the booking and
 * refund steps: this scenario's booking identity, its attendee pages, the
 * Money records, the refund form, and the provider refund observation. Each
 * helper takes the scenario's World, so the steps hand over one value and the
 * owner session, booker identity, and credentials can never drift apart.
 */

// jscpd:ignore-start -- this #e2e import run is structural
import type { BrowserSession } from "#e2e/browser.ts";
import { catalogWords } from "#e2e/catalog-words.ts";
import { config } from "#e2e/config.ts";
import type { LiveWorld } from "#e2e/cucumber/support/world.ts";
// jscpd:ignore-end
import {
  type BookingIdentity,
  countOnRoster,
  openListing,
  requireNoRecognisedIncome,
  submitBooking,
} from "#e2e/flow.ts";
import { pageTextCount, pageTextIncludes } from "#e2e/page-text.ts";
import type { SandboxRefundObservation } from "#e2e/providers/types.ts";
import type { RefundPageFacts } from "#e2e/refund-outcome.ts";
import { SCHEMA_ATLAS_MACHINES } from "#shared/schema-atlas/index.ts";

/** Fail loudly with what was counted when a number is not what the scenario
 * promised. */
export const requireExactly = (
  actual: number,
  expected: number,
  what: string,
): void => {
  if (actual !== expected) {
    throw new Error(`expected ${expected} ${what}, found ${actual}`);
  }
};

/** How many links with this exact visible text the page offers. */
export const exactLinkCount = async (
  session: BrowserSession,
  text: string,
): Promise<number> =>
  await session.page.getByRole("link", { exact: true, name: text }).count();

/** The page must not offer any link with this exact visible text. */
export const requireNoExactLink = async (
  session: BrowserSession,
  text: string,
  what: string,
): Promise<void> =>
  requireExactly(await exactLinkCount(session, text), 0, what);

/** The booking this scenario is about, for every admin-side assertion. */
export const bookingIdentity = (world: LiveWorld): BookingIdentity => ({
  booker: world.scenario.booker,
  listingName: world.scenario.listingName,
  priceMinor: config.unitPrice,
});

/** Open this scenario's listing admin page and return its body text. */
export const openScenarioListing = (
  world: LiveWorld,
  tab: "overview" | "attendees",
): Promise<string> =>
  openListing(
    ownerOf(world),
    world.scenario.listingName,
    world.scenario.owner,
    tab,
  );

/** The listing's Attendees roster, opened fresh. */
export const openScenarioRoster = (world: LiveWorld): Promise<string> =>
  openScenarioListing(world, "attendees");

/** How many times the booker appears on the listing's Attendees tab. */
export const bookingsOnRoster = async (world: LiveWorld): Promise<number> =>
  countOnRoster(await openScenarioRoster(world), world.scenario.booker.email);

/** The roster must mention this text. */
export const requireOnScenarioRoster = async (
  world: LiveWorld,
  expected: string,
  missing: string,
): Promise<void> => {
  const roster = await openScenarioRoster(world);
  if (!roster.includes(expected)) throw new Error(missing);
};

/** Exactly one booking for this scenario's booker is on the roster. */
export const requireSingleBooking = async (
  world: LiveWorld,
  what: string,
): Promise<void> => requireExactly(await bookingsOnRoster(world), 1, what);

/** The listing page must show no recognised income (a free booking). */
export const requireNoPaymentIncome = async (
  world: LiveWorld,
): Promise<void> => {
  await openScenarioListing(world, "overview");
  await requireNoRecognisedIncome(ownerOf(world));
};

/** The visitor submits the booking form on the published listing. */
export const bookAsVisitor = (world: LiveWorld): Promise<void> =>
  submitBooking(
    world.resources.visitor,
    world.bookingPath,
    world.scenario.booker,
  );

/** The scenario's owner session. */
export const ownerOf = (world: LiveWorld): BrowserSession =>
  world.resources.owner;

/** Open this scenario's attendee (the booker's row) on its Overview tab. */
export const openAttendeePage = async (world: LiveWorld): Promise<void> => {
  await openAttendeePageIn(ownerOf(world), world);
};

/** The same navigation inside an independently signed-in owner window. */
export const openAttendeePageIn = async (
  session: BrowserSession,
  world: LiveWorld,
): Promise<void> => {
  const roster = await openListing(
    session,
    world.scenario.listingName,
    world.scenario.owner,
    "attendees",
  );
  if (!roster.includes(world.scenario.booker.email)) {
    await session.dumpPage("attendee-missing-from-roster");
    throw new Error(
      `${world.scenario.booker.email} is not on the ${world.scenario.listingName} roster`,
    );
  }
  await session.clickLink(world.scenario.booker.name);
};

/** The attendee's current URL (…/admin/attendees/<id>…). */
const attendeePathOf = (session: BrowserSession): string => {
  const match = session.page.url().match(/\/admin\/attendees\/(\d+)/);
  if (!match) {
    throw new Error(`not on an attendee page (at ${session.page.url()})`);
  }
  return `/admin/attendees/${match[1]}`;
};

/** The tab read inside any owner session (the second stale-form window needs
 * this against its own signed-in session). */
export const openAttendeeTabIn = async (
  session: BrowserSession,
  tab: "" | "actions" | "ledger",
): Promise<string> => {
  await session.goto(
    `${attendeePathOf(session)}${tab === "" ? "" : `/${tab}`}`,
  );
  return await session.bodyText();
};

/** Read — never send — this checkout's refund state, recording the journal. */
export const observeRefund = async (
  world: LiveWorld,
): Promise<SandboxRefundObservation> => {
  const { provider, secrets } = world.paidProvider;
  const observation = await provider.observeRefund(world.paidCheckout, secrets);
  world.recordObservation(JSON.stringify(observation));
  return observation;
};

/** The provider must show exactly the captured amount returned — nothing
 * more, never reported as a different or partial sum. */
export const requireFullAmountReturned = async (
  world: LiveWorld,
  context: string,
): Promise<void> => {
  const observation = await observeRefund(world);
  if (
    observation.kind !== "completed" ||
    observation.returnedAmount !== config.unitPrice
  ) {
    throw new Error(
      `${context}: expected the full captured amount (${config.unitPrice}) ` +
        `returned, observed: ${JSON.stringify(observation)}`,
    );
  }
};

/**
 * Gather the refund page facts for classification. The warning is read from
 * the page the submission landed on (its flash does not survive navigation),
 * then the attendee Overview supplies the refund status and Refresh control,
 * and the Actions tab supplies the offered actions.
 */
export const gatherRefundPageFacts = async (
  world: LiveWorld,
): Promise<RefundPageFacts> => {
  const landing = await ownerOf(world).bodyText();
  const unfinishedWorkWarningVisible =
    /do not send the refund again|could not be recorded in money/i.test(
      landing,
    );

  const { overview, paymentDetails } = await attendeeOverviewFacts(world);
  const refundedVisible =
    (await pageTextIncludes(
      paymentDetails,
      "attendees",
      "admin.attendees.refund_status",
    )) &&
    !(await pageTextIncludes(
      paymentDetails,
      "attendees",
      "admin.attendees.not_refunded",
    )) &&
    (await pageTextIncludes(
      paymentDetails,
      "attendees",
      "admin.attendees.refunded",
    ));
  const refreshReachable = await pageTextIncludes(
    overview,
    "attendees",
    "admin.attendees.refresh_payment",
  );

  await openAttendeeTabIn(ownerOf(world), "actions");
  return {
    deleteActionVisible:
      (await exactLinkCount(
        ownerOf(world),
        await catalogWords("common", "common.delete"),
      )) > 0,
    refreshReachable,
    refundActionVisible:
      (await exactLinkCount(
        ownerOf(world),
        await catalogWords("attendees", "attendee_form.action_refund"),
      )) > 0,
    refundedVisible,
    unfinishedWorkWarningVisible,
  };
};

/** Open this scenario's attendee and return the given tab's text. */
export const attendeeTabOf = async (
  world: LiveWorld,
  tab: "" | "actions" | "ledger",
): Promise<string> => {
  await openAttendeePage(world);
  return await openAttendeeTabIn(ownerOf(world), tab);
};

/** How many refund transfers the attendee's Money statement carries. */
export const moneyRefundCount = async (world: LiveWorld): Promise<number> =>
  await pageTextCount(
    await attendeeTabOf(world, "ledger"),
    "ledger",
    "admin.ledger.human.refund_cash",
  );

/** The attendee's Money statement must carry exactly this many refunds. */
export const requireMoneyRefunds = async (
  world: LiveWorld,
  expected: number,
  what: string,
): Promise<void> =>
  requireExactly(await moneyRefundCount(world), expected, what);

/** The attendee Overview's body text and its Payment Details block. */
export const attendeeOverviewFacts = async (
  world: LiveWorld,
): Promise<{ overview: string; paymentDetails: string }> => {
  const overview = await attendeeTabOf(world, "");
  const paymentDetails = await ownerOf(world)
    .page.locator(".prose", {
      hasText: await catalogWords(
        "attendees",
        "admin.attendees.payment_details",
      ),
    })
    .first()
    .innerText();
  return { overview, paymentDetails };
};

/** Open the attendee's rendered refund confirmation form (not submitted). */
export const openRefundForm = async (world: LiveWorld): Promise<void> => {
  await attendeeTabOf(world, "actions");
  await ownerOf(world).clickLink(
    await catalogWords("attendees", "attendee_form.action_refund"),
  );
};

/**
 * The system map's promises this scenario must leave true: every declared
 * machine renders, the live check finds no stored rule break, and no SumUp
 * money is waiting on the operator. This runs against the scenario's real
 * stored rows, so a refund mid-observation and a young SumUp staging row
 * must both read as clean — a flagged row here is a machine whose declared
 * rules and real writes disagree.
 */
export const requireSystemMapAnswersClean = async (
  world: LiveWorld,
): Promise<void> => {
  const session = ownerOf(world);
  await session.goto("/admin/schema");
  const body = await session.bodyText();
  const promises = [
    "All stored records fit the system rules.",
    "No SumUp checkout needs your attention.",
  ];
  const missing = promises.filter((line) => !body.includes(line));
  const machines = await session.page
    .locator("[data-schema-atlas-machine]")
    .count();
  if (missing.length === 0 && machines === SCHEMA_ATLAS_MACHINES.length) {
    return;
  }
  await session.dumpPage("system-map-not-clean");
  throw new Error(
    "the system map did not answer clean: " +
      `${machines}/${SCHEMA_ATLAS_MACHINES.length} machines rendered; ` +
      `missing: ${missing.join(" | ") || "none"}`,
  );
};

/** Submit the currently-rendered refund confirmation form. */
export const submitRenderedRefundForm = async (
  session: BrowserSession,
  bookerName: string,
): Promise<void> => {
  await session.fill("confirm_identifier", bookerName);
  await session.clickButton(
    await catalogWords("attendees", "admin.attendees.refund_submit"),
  );
};
