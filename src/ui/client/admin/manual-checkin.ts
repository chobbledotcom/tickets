/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Manual check-in: a search by name, then a pick from what it found. A
 * submit with nobody picked searches. A submit with a person picked checks
 * them in, through the scan JSON API or the offline queue. No step reloads
 * the page, so the camera keeps running. */

import * as v from "valibot";
import { requiredMapValue } from "#fp";
import {
  type AnswerOf,
  type ScanAnswer,
  ScanAnswerSchema,
} from "#src/ui/client/admin/manual-answer.ts";
import {
  findPeople,
  type ManualOffline,
  type Person,
  type Say,
  SEARCH_MIN_LENGTH,
} from "#src/ui/client/admin/manual-search.ts";
import { showConfirm } from "#src/ui/client/confirm-dialog.ts";
import { showQuantitySelect } from "#src/ui/client/quantity-select.ts";

type OptionDirection = "up" | "down";

const KEY_DIRECTIONS: Partial<Record<string, OptionDirection>> = {
  ArrowDown: "down",
  ArrowUp: "up",
};

/** The answers the door gave so far for one pick. */
type Given = { id_verified?: true; quantity?: number };

/** Wire the page's manual check-in. `offline` is the scanner's offline side,
 * or null on a page whose offline side did not start. */
export const initManualCheckin = (offline: ManualOffline | null): void => {
  const form = document.querySelector<HTMLFormElement>("[data-manual-checkin]");
  if (!form) return;

  const input = form.querySelector<HTMLInputElement>("#manual-checkin-input")!;
  const submitBtn = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  const listbox = document.getElementById("ticket-options")!;
  const statusEl = document.getElementById("manual-checkin-status")!;
  const scanPath = form.dataset.scanPath!;
  const csrfInput = form.querySelector<HTMLInputElement>(
    'input[name="csrfToken"]',
  )!;
  const messages = form.dataset;

  const interpolate = (template: string, values: Record<string, unknown>) =>
    template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

  const getMessage = (key: string, fallback: string) =>
    messages[key] ?? fallback;

  const formatTicketCount = (count: number) =>
    interpolate(
      getMessage(
        count === 1 ? "messageTicketCountOne" : "messageTicketCountOther",
        "{count} ticket",
      ),
      { count },
    );

  const allOptions = () => [
    ...listbox.querySelectorAll<HTMLElement>("[role='option']"),
  ];

  /** Opens or closes the result list, telling a screen reader either way. */
  const setListOpen = (open: boolean) => {
    listbox.classList.toggle("hidden", !open);
    input.setAttribute("aria-expanded", String(open));
  };

  /** Each shown option's person, so a pick reads what the search found. */
  let personByOption = new Map<Element, Person>();

  /** The person the door picked, or null while the next submit searches. */
  let picked: Person | null = null;

  /** Word the submit button for what the next submit does. */
  const setPicked = (person: Person | null) => {
    picked = person;
    const label = submitBtn.querySelector("span");
    if (label) {
      label.textContent = person
        ? getMessage("messageCheckInButton", "Check In")
        : getMessage("messageSearchButton", "Search");
    }
  };

  const selectOption = (opt: HTMLElement) => {
    const person = requiredMapValue(personByOption, opt);
    setPicked(person);
    const detail = person.details.join(", ");
    input.value =
      `${person.name} (${formatTicketCount(Number(opt.dataset.quantity))})` +
      (detail ? ` — ${detail}` : "");
    setListOpen(false);
  };

  // A changed name makes the shown results stale: the next submit searches.
  input.addEventListener("input", () => {
    setPicked(null);
    setListOpen(false);
  });

  input.addEventListener("focus", () => {
    setListOpen(allOptions().length > 0);
  });

  document.addEventListener("click", (e) => {
    if (
      !input.contains(e.target as Node) &&
      !listbox.contains(e.target as Node)
    ) {
      setListOpen(false);
    }
  });

  const getActiveOption = () =>
    listbox.querySelector<HTMLElement>("[role='option'].combobox-active");

  const navigateOptions = (direction: OptionDirection) => {
    const options = allOptions();
    if (options.length === 0) return;
    const active = getActiveOption();
    const idx = active ? options.indexOf(active) : -1;
    active?.classList.remove("combobox-active");
    const step = direction === "down" ? 1 : -1;
    const next = options[(idx + step + options.length) % options.length]!;
    next.classList.add("combobox-active");
    next.scrollIntoView({ block: "nearest" });
  };

  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setListOpen(false);
      return;
    }
    const direction = KEY_DIRECTIONS[e.key];
    if (direction) {
      e.preventDefault();
      navigateOptions(direction);
      return;
    }
    if (e.key !== "Enter") return;
    const active = getActiveOption();
    if (!active) return;
    e.preventDefault();
    selectOption(active);
  });

  listbox.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(
      "[role='option']",
    );
    if (opt) selectOption(opt);
  });

  const say: Say = (message, type) => {
    statusEl.textContent = message;
    statusEl.classList.remove(
      "hidden",
      "checkin-status-success",
      "checkin-status-warning",
      "checkin-status-error",
    );
    statusEl.classList.add("checkin-status", `checkin-status-${type}`);
  };

  /** Relabel one option with the tickets its person still owes. */
  const relabelOption = (opt: HTMLElement, remaining: number) => {
    const { details, name } = requiredMapValue(personByOption, opt);
    opt.dataset.quantity = String(remaining);
    const detail = details.join(", ");
    opt.textContent = interpolate(
      detail
        ? getMessage(
            "messageTicketOptionDetail",
            "{name} ({tickets}) — {detail}",
          )
        : getMessage("messageTicketOption", "{name} ({tickets})"),
      { detail, name, tickets: formatTicketCount(remaining) },
    );
  };

  /** Show what one search found as the options the door picks from. */
  const showFound = (people: Person[]) => {
    personByOption = new Map();
    listbox.replaceChildren(
      ...people.map((person) => {
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.tabIndex = 0;
        opt.dataset.key = person.key;
        personByOption.set(opt, person);
        relabelOption(opt, person.quantity);
        return opt;
      }),
    );
  };

  /** A person the door still owes tickets keeps their option. The option
   * shows what is left: part of a party, or listings a scan did not cover. */
  const showRemaining = (key: string, remaining: number) => {
    for (const opt of allOptions()) {
      if (opt.dataset.key !== key) continue;
      if (remaining > 0) relabelOption(opt, remaining);
      else opt.remove();
    }
  };

  /** One counted answer as the values its message names. A part answer
   * names its raw counts, so "(2 of 3 tickets)" reads as counts. */
  const countedValues = (
    answer: AnswerOf<"already_checked_in" | "checked_in">,
  ) => {
    const partial = answer.total > answer.quantity;
    return {
      listingName: answer.listingName,
      name: answer.name,
      partial,
      tickets: partial
        ? String(answer.quantity)
        : formatTicketCount(answer.quantity),
      total: String(answer.total),
    };
  };

  /** What the door reads for one final answer, keyed by its status. Each
   * answers whether the door is done with the pick. An ask that comes back
   * after the door answered it is an answer this page cannot settle. */
  const answerHandlers: {
    [Status in ScanAnswer["status"]]: (
      answer: AnswerOf<Status>,
      key: string,
      given: Given,
    ) => boolean;
  } = {
    already_checked_in: (answer) => {
      say(
        interpolate(
          getMessage(
            "messageAlreadyCheckedIn",
            "{name} already checked in for {listingName} ({tickets})",
          ),
          countedValues(answer),
        ),
        "warning",
      );
      return false;
    },
    checked_in: (answer, key, given) => {
      const values = countedValues(answer);
      const idNote = given.id_verified
        ? getMessage("messageVerifyIdNote", " — verify their ID")
        : "";
      say(
        `${interpolate(
          getMessage(
            values.partial ? "messageCheckedInPartial" : "messageCheckedIn",
            "{name} checked in for {listingName} ({tickets})",
          ),
          values,
        )}${idNote}`,
        "success",
      );
      showRemaining(key, answer.remaining);
      return true;
    },
    not_found: () => {
      say(getMessage("messageNotFound", "Ticket not found"), "error");
      return false;
    },
    other: (answer) => showFailure(answer.error ?? answer.message),
    refunded: (answer) => {
      say(
        interpolate(getMessage("messageRefunded", "{name} has been refunded"), {
          name: answer.name,
        }),
        "error",
      );
      return false;
    },
    select_quantity: () => showFailure(undefined),
    verify_id: () => showFailure(undefined),
  };

  /** Say why an answer settled nothing: the answer's own words, or the
   * page's error message when it has none. */
  const showFailure = (words: string | undefined) => {
    say(words ?? getMessage("messageError", "Error"), "error");
    return false;
  };

  /** The one question an answer asks the door, or null when it asks none
   * the door has not answered. */
  const pendingAsk = (answer: ScanAnswer, given: Given) => {
    if (answer.status === "verify_id" && !given.id_verified) return answer;
    if (answer.status === "select_quantity" && given.quantity === undefined) {
      return answer;
    }
    return null;
  };

  /** Ask the door the one question an answer needs, and return the choice
   * to re-post, or null when the door declined. A non-transferable listing
   * needs the door to look at the person's ID and say so — never assert it
   * from the name pick alone. A ticket that owes more than one place asks
   * how many to admit, capped by what the lines owe. */
  const askDoor = async (
    ask: AnswerOf<"select_quantity" | "verify_id">,
  ): Promise<Given | null> => {
    if (ask.status === "verify_id") {
      const confirmed = await showConfirm(
        interpolate(
          getMessage("messageVerifyIdConfirm", 'Does their ID match "{name}"?'),
          { name: ask.name },
        ),
      );
      return confirmed ? { id_verified: true } : null;
    }
    const count = await showQuantitySelect(
      ask.max,
      interpolate(
        getMessage("messageSelectQuantity", "How many tickets for {name}?"),
        { name: ask.name },
      ),
      formatTicketCount,
    );
    return count === null ? null : { quantity: count };
  };

  const postScan = async (body: Record<string, unknown>) => {
    const r = await fetch(scanPath, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfInput.value,
      },
      method: "POST",
    });
    return v.parse(ScanAnswerSchema, await r.json());
  };

  /** Settle one pick with the door. Each ask is answered once: the re-post
   * carries every earlier answer, so a verified ID still stands when the
   * door then picks a count. Answers whether the door is done with it. */
  const checkInById = async (attendeeId: number): Promise<boolean> => {
    let given: Given = {};
    let answer = await postScan({ attendee_id: attendeeId });
    for (
      let ask = pendingAsk(answer, given);
      ask;
      ask = pendingAsk(answer, given)
    ) {
      const choice = await askDoor(ask);
      if (!choice) {
        say(
          interpolate(getMessage("messageSkipped", "Skipped {name}"), {
            name: ask.name,
          }),
          "warning",
        );
        return true;
      }
      given = { ...given, ...choice };
      answer = await postScan({ attendee_id: attendeeId, ...given });
    }
    const handle = answerHandlers[answer.status] as (
      answer: ScanAnswer,
      key: string,
      given: Given,
    ) => boolean;
    return handle(answer, String(attendeeId), given);
  };

  /** Search by the typed name and show what the search found. */
  const search = async () => {
    const text = input.value.trim();
    if (text.length < SEARCH_MIN_LENGTH) {
      say(
        getMessage(
          "messageSearchTooShort",
          "Type at least 2 letters of the name.",
        ),
        "warning",
      );
      return;
    }
    const found = await findPeople(text, {
      checkInById,
      failedText: getMessage(
        "messageSearchFailed",
        "The search did not work. Check your connection, then try again.",
      ),
      offline,
      say,
      scanPath,
    });
    showFound(found ?? []);
    if (found === null) return;
    if (found.length === 0) {
      say(
        getMessage(
          "messageSearchNone",
          "Nobody at this door matches that name.",
        ),
        "warning",
      );
      return;
    }
    statusEl.classList.add("hidden");
    setListOpen(true);
  };

  /** Settle the door's pick, then clear it once the door is done with it. */
  const settlePick = async (person: Person) => {
    if (await person.checkIn(say)) {
      setPicked(null);
      input.value = "";
    }
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      await (picked === null ? search() : settlePick(picked));
    } catch {
      say(getMessage("messageNetworkError", "Network error"), "error");
    } finally {
      submitBtn.disabled = false;
    }
  });
};
