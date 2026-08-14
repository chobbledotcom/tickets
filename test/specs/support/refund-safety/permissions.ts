/** Browser journeys that prove manager accounts cannot use owner money forms. */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import { sessionCookie } from "#test/specs/support/evidence.ts";
import { choicesForQuestion } from "#test/specs/support/form-controls/reading.ts";
import { managerBrowser } from "#test/specs/support/staff-accounts.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  appendFormValue,
  extractFormEntries,
  findFormByButton,
  findForms,
} from "#test-utils/test-browser/forms.ts";
import { stripTags } from "#test-utils/test-browser/parsing.ts";
import { openListedRefundCase, openOwnerAction } from "./journeys.ts";
import {
  refundSafety,
  safetyBooking,
  type SavedOwnerForm,
  type SavedOwnerFormKind,
} from "./state.ts";

// jscpd:ignore-end

type ActOnSavedOwnerForm = (
  world: TicketsWorld,
  manager: string,
  kind: SavedOwnerFormKind,
) => Promise<void>;

const savedForm = (
  world: TicketsWorld,
  kind: SavedOwnerFormKind,
): SavedOwnerForm => {
  const saved = refundSafety(world).savedOwnerForms.get(kind);
  if (saved === undefined) {
    throw new Error(`The owner has not saved a ${kind} form`);
  }
  return saved;
};

const keepSavedForm = (
  world: TicketsWorld,
  kind: SavedOwnerFormKind,
  form: SavedOwnerForm,
): void => {
  refundSafety(world).savedOwnerForms.set(kind, form);
};

const hiddenValue = (html: string, name: string): string => {
  const value = extractFormEntries(html).find(([field]) => field === name)?.[1];
  if (value === undefined || value === "") {
    throw new Error(`The owner form omitted ${name}`);
  }
  return value;
};

const ACTION_LINK = {
  "provider-recovery": "Open Refund recovery",
  refund: "Refund",
  review: "Mark payment reviewed",
} as const satisfies Record<SavedOwnerFormKind, string>;

type SimpleOwnerForm = Exclude<SavedOwnerFormKind, "provider-recovery">;

const SIMPLE_FORM_BUTTON = {
  refund: "Refund Attendee",
  review: "Mark payment reviewed",
} as const satisfies Record<SimpleOwnerForm, string>;

const oneButtonText = (body: string): string => {
  const buttons = [...body.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/gi)]
    .map((match) => stripTags(match[1]!))
    .filter((text) => text !== "");
  if (buttons.length !== 1) {
    throw new Error("The refund recovery form did not have one submit button");
  }
  return buttons[0]!;
};

const recoveryChoice = (body: string): string => {
  const hidden = extractFormEntries(body).find(([name]) => name === "choice")
    ?.[1];
  if (hidden !== undefined && hidden !== "") return hidden;
  const offered = choicesForQuestion(body, "choice");
  if (offered.length === 0) {
    throw new Error("The refund recovery form offered no choice");
  }
  return offered[0]!;
};

const recoveryFormOn = (html: string, path: string) => {
  const forms = findForms(html).filter((form) =>
    form.action === path &&
    extractFormEntries(form.body).some(([name]) => name === "revision")
  );
  if (forms.length !== 1) {
    throw new Error("The refund recovery page did not have one recovery form");
  }
  const form = forms[0]!;
  return {
    button: oneButtonText(form.body),
    form,
    values: {
      choice: recoveryChoice(form.body),
      revision: hiddenValue(form.body, "revision"),
    },
  };
};

/** Save the exact owner-rendered form and address a copied submission uses. */
export const saveOwnerMoneyForm = async (
  world: TicketsWorld,
  who: string,
  kind: SavedOwnerFormKind,
): Promise<SavedOwnerForm> => {
  const browser = await openOwnerAction(world, who, ACTION_LINK[kind]);
  if (kind === "provider-recovery") {
    await openListedRefundCase(browser);
  }
  const details = kind === "provider-recovery"
    ? recoveryFormOn(browser.currentHtml, browser.currentUrl)
    : {
      button: SIMPLE_FORM_BUTTON[kind],
      form: findFormByButton(
        findForms(browser.currentHtml),
        SIMPLE_FORM_BUTTON[kind],
        ["confirm_identifier"],
      ),
      values: { confirm_identifier: who },
    };
  const saved: SavedOwnerForm = {
    attendeeId: safetyBooking(world, who).attendeeId,
    button: details.button,
    html: browser.currentHtml,
    path: browser.currentUrl,
    values: details.values,
  };
  expect(details.form.action).toBe(browser.currentUrl);
  expect(details.form.method).toBe("post");
  keepSavedForm(world, kind, saved);
  return saved;
};

/** Ask for the copied owner address through the manager's signed-in browser. */
export const managerOpensSavedOwnerAddress: ActOnSavedOwnerForm = async (
  world,
  manager,
  kind,
) => {
  const answer = await managerBrowser(world, manager).statusOf(
    savedForm(world, kind).path,
  );
  refundSafety(world).managerAnswer = answer;
};

/** Submit a copied owner form with the manager's real session.
 *
 * Every destination, successful control, button value and typed value comes
 * from the served owner form. Only the browser cookie changes, exactly as it
 * would when somebody copied the page into another signed-in window. */
export const managerSubmitsSavedOwnerForm: ActOnSavedOwnerForm = async (
  world,
  manager,
  kind,
) => {
  const saved = savedForm(world, kind);
  const rendered = findFormByButton(
    findForms(saved.html),
    saved.button,
    Object.keys(saved.values),
  );
  if (rendered.method !== "post") {
    throw new Error(`The saved ${kind} form does not send by POST`);
  }
  const body = new URLSearchParams(extractFormEntries(rendered.body));
  if (rendered.buttonName && rendered.buttonValue !== undefined) {
    body.append(rendered.buttonName, rendered.buttonValue);
  }
  for (const [name, value] of Object.entries(saved.values)) {
    appendFormValue(body, name, value, rendered.body);
  }
  const browser = managerBrowser(world, manager);
  await browser.visit(`/admin/attendees/${saved.attendeeId}/actions`);
  await browser.clickLink("Edit");
  const managerCsrf = findForms(browser.currentHtml)
    .flatMap(({ body }) => extractFormEntries(body))
    .find(([name]) => name === "csrf_token")?.[1];
  if (managerCsrf === undefined) {
    throw new Error("The manager's Actions page offered no valid form token");
  }
  body.set("csrf_token", managerCsrf);
  const response = await handleRequest(
    new Request(`http://localhost${rendered.action}`, {
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: sessionCookie(browser),
        host: "localhost",
      },
      method: "POST",
    }),
  );
  refundSafety(world).managerAnswer = response.status;
};

/** Every attendee action button rendered to this manager opens for them. */
export const expectManagerActionsOpen = async (
  world: TicketsWorld,
  manager: string,
  who: string,
): Promise<void> => {
  const browser = managerBrowser(world, manager);
  const attendeeId = safetyBooking(world, who).attendeeId;
  const actionLinks = browser.links
    .filter(
      ({ href }) =>
        href.startsWith(`/admin/attendees/${attendeeId}/`) ||
        href.includes(`attendee=${attendeeId}`),
    )
    .filter(({ href }) => !href.endsWith("/actions"));
  expect(actionLinks.length).toBeGreaterThan(0);
  const answers = await Promise.all(
    actionLinks.map(({ href }) => browser.statusOf(href)),
  );
  expect(answers).toEqual(answers.map(() => 200));
};
