/** Two real owner browsers acting while one provider refund is paused. */

// jscpd:ignore-start
import { t } from "#i18n";
import type { RefundRequest } from "#payment/refund-attempt.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import type { PutsThingsBack } from "#test/specs/support/memory.ts";
import { loggedInAdminBrowser } from "#test-utils/e2e.ts";
import {
  extractFormEntries,
  type FormEntry,
} from "#test-utils/test-browser/forms.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { PausedProviderRefund } from "./provider-script.ts";

// jscpd:ignore-end

type OwnerAction = "delete" | "refund";

interface ActionWords {
  readonly button: string;
  readonly link: string;
}

const actionWords = (action: OwnerAction): ActionWords =>
  (
    ({
      delete: {
        button: t("admin.attendees.delete_submit"),
        link: t("attendee_form.action_delete"),
      },
      refund: {
        button: t("admin.attendees.refund_submit"),
        link: t("attendee_form.action_refund"),
      },
    }) satisfies Record<OwnerAction, ActionWords>
  )[action];

/** One confirmation form exactly as one owner browser was served it. */
export interface RenderedActionForm {
  readonly action: OwnerAction;
  readonly browser: TestBrowser;
  readonly button: string;
  readonly formHtml: string;
  readonly page: string;
  readonly renderedValues: readonly FormEntry[];
  readonly typedValues: Record<string, string>;
}

/** A refund request held at the provider while its browser is still waiting. */
export interface RunningRefund {
  readonly pause: PausedProviderRefund;
  readonly request: RefundRequest;
  readonly submission: Promise<void>;
}

/** Two separately authenticated owner windows and the forms kept in them. */
export interface RefundWindows {
  readonly first: TestBrowser;
  forms?: {
    readonly first: RenderedActionForm;
    readonly second?: RenderedActionForm;
  };
  running?: RunningRefund;
  readonly second: TestBrowser;
}

/** The same pair before either window has opened its attendee action. */
export type OwnerWindows = Pick<RefundWindows, "first" | "second">;

/** Sign the seeded owner in through two separate real login forms. */
export const logInOwnerWindows = async (): Promise<RefundWindows> => {
  const first = await loggedInAdminBrowser();
  const second = await loggedInAdminBrowser();
  if (first === second) throw new Error("The owner was given only one browser");
  return { first, second };
};

/** Follow the attendee list and Actions links to one confirmation form. */
const openActionForm = async (
  browser: TestBrowser,
  attendeeId: number,
  attendeeName: string,
  action: OwnerAction,
): Promise<RenderedActionForm> => {
  await browser.visit("/admin/");
  await browser.clickLink(t("terms.attendees"));
  const attendeePath = `/admin/attendees/${attendeeId}`;
  const attendeeLink = browser.links.find(({ href }) => href === attendeePath);
  if (attendeeLink === undefined) {
    throw new Error(`The attendee list has no way into ${attendeeName}`);
  }
  await browser.visit(attendeeLink.href);
  await browser.clickLink(t("entity.tab.actions"));
  const words = actionWords(action);
  await browser.clickLink(words.link);
  const typedValues = { confirm_identifier: attendeeName };
  const formHtml = browser.formBodyFor(words.button, ["confirm_identifier"]);
  return {
    action,
    browser,
    button: words.button,
    formHtml,
    page: browser.currentUrl,
    renderedValues: extractFormEntries(formHtml),
    typedValues,
  };
};

type OpensAction = (
  windows: RefundWindows,
  attendeeId: number,
  attendeeName: string,
) => Promise<RefundWindows>;

const opensAction =
  (window: "first" | "second", action: OwnerAction): OpensAction =>
  async (windows, attendeeId, attendeeName) => {
    const opened = await openActionForm(
      windows[window],
      attendeeId,
      attendeeName,
      action,
    );
    if (window === "first") windows.forms = { first: opened };
    else {
      windows.forms = {
        first: preparedForms(windows).first,
        second: opened,
      };
    }
    return windows;
  };

/** Open only the first window's refund form, leaving the second for a merge. */
export const openRefundInFirstWindow: OpensAction = opensAction(
  "first",
  "refund",
);

const opensForms =
  (secondAction: OwnerAction): OpensAction =>
  async (windows, attendeeId, attendeeName) => {
    await openRefundInFirstWindow(windows, attendeeId, attendeeName);
    return await opensAction("second", secondAction)(
      windows,
      attendeeId,
      attendeeName,
    );
  };

/** Open the same rendered refund confirmation independently in both windows. */
export const openRefundFormsInTwoWindows: OpensAction = opensForms("refund");

/** Open refund in the first window and delete in the second. */
export const openRefundAndDeleteForms: OpensAction = opensForms("delete");

/** Open only the second window's delete form after the first kept its refund. */
export const openDeleteInSecondWindow: OpensAction = opensAction(
  "second",
  "delete",
);

const preparedForms = (
  windows: RefundWindows,
): NonNullable<RefundWindows["forms"]> => {
  if (windows.forms === undefined) {
    throw new Error("The owner has not opened both confirmation forms");
  }
  return windows.forms;
};

const secondPreparedForm = (windows: RefundWindows): RenderedActionForm => {
  const second = preparedForms(windows).second;
  if (second === undefined) {
    throw new Error("The second owner window has not opened an action form");
  }
  return second;
};

const runningRefund = (windows: RefundWindows): RunningRefund => {
  if (windows.running === undefined) {
    throw new Error("No owner window has started the paused refund");
  }
  return windows.running;
};

/** Send only values that the kept rendered form really offered. */
const submitRenderedForm = async (
  rendered: RenderedActionForm,
): Promise<void> => {
  if (rendered.browser.currentUrl !== rendered.page) {
    throw new Error(`The ${rendered.action} window left its confirmation page`);
  }
  const currentForm = rendered.browser.formBodyFor(
    rendered.button,
    Object.keys(rendered.typedValues),
  );
  if (currentForm !== rendered.formHtml) {
    throw new Error(`The rendered ${rendered.action} form changed before send`);
  }
  await fillInAndSend(rendered.browser, rendered.typedValues, rendered.button);
};

type SubmissionOutcome =
  | { readonly kind: "finished" }
  | { readonly error: unknown; readonly kind: "failed" };

const outcomeOf = async (
  submission: Promise<void>,
): Promise<SubmissionOutcome> => {
  try {
    await submission;
    return { kind: "finished" };
  } catch (error) {
    return { error, kind: "failed" };
  }
};

const providerStartOf = async (
  started: Promise<RefundRequest>,
): Promise<{ readonly kind: "started"; readonly request: RefundRequest }> => ({
  kind: "started",
  request: await started,
});

/**
 * Start the first rendered refund, register its emergency release immediately,
 * and return only after the production route is genuinely waiting on the
 * provider.
 */
export const startRefundAndWait = async (
  windows: RefundWindows,
  pause: PausedProviderRefund,
  cleanup: Pick<PutsThingsBack, "add">,
): Promise<RunningRefund> => {
  if (windows.running !== undefined) {
    throw new Error("The first refund window was already submitted");
  }
  const submission = submitRenderedForm(preparedForms(windows).first);
  const outcome = outcomeOf(submission);
  cleanup.add(async () => {
    pause.release();
    await submission;
  });

  const reached = await Promise.race([providerStartOf(pause.started), outcome]);
  if (reached.kind === "failed") throw reached.error;
  if (reached.kind === "finished") {
    throw new Error("The refund form finished before reaching the provider");
  }
  const running = { pause, request: reached.request, submission };
  windows.running = running;
  return running;
};

/** Submit the second window while the first provider answer remains paused. */
export const submitSecond = async (
  windows: RefundWindows,
): Promise<TestBrowser> => {
  runningRefund(windows);
  const second = secondPreparedForm(windows);
  await submitRenderedForm(second);
  return second.browser;
};

/** Release the provider and wait until both it and the first browser finish. */
export const releaseAndWait = async (
  windows: RefundWindows,
): Promise<TestBrowser> => {
  const running = runningRefund(windows);
  running.pause.release();
  await Promise.all([running.pause.finished, running.submission]);
  return preparedForms(windows).first.browser;
};
