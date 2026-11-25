/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Manual check-in: a search by name, then a pick from what it found. A
 * submit with nobody picked searches. A submit with a person picked checks
 * them in, through the scan JSON API or the offline queue. No step reloads
 * the page, so the camera keeps running. */

import { requiredMapValue } from "#fp";
import type { Wording } from "#shared/scanner-words.ts";
import {
  findPeople,
  type ManualOffline,
  type Person,
  SEARCH_MIN_LENGTH,
} from "#src/ui/client/admin/manual-search.ts";
import { requiredById, requiredChild } from "#src/ui/client/dom.ts";
import {
  failLoudly,
  postScanBody,
  settleLiveScan,
} from "#src/ui/client/scan-flow.ts";
import { paintStatus, type Say } from "#src/ui/client/scanner-messages.ts";

type OptionDirection = "up" | "down";

const KEY_DIRECTIONS: Partial<Record<string, OptionDirection>> = {
  ArrowDown: "down",
  ArrowUp: "up",
};

/** What the manual check-in needs from its page. */
export type ManualPage = {
  csrfToken: string;
  offline: ManualOffline;
  scanPath: string;
  wording: Wording;
};

/** Wire the page's manual check-in. */
export const initManualCheckin = ({
  csrfToken,
  offline,
  scanPath,
  wording,
}: ManualPage): void => {
  const input = requiredById<HTMLInputElement>("manual-checkin-input");
  const submitBtn = requiredById<HTMLButtonElement>("manual-checkin-submit");
  const submitLabel = requiredChild<HTMLElement>(submitBtn, "span");
  const form = requiredById<HTMLFormElement>("manual-checkin");
  const listbox = requiredById<HTMLElement>("ticket-options");
  const statusEl = requiredById<HTMLElement>("manual-checkin-status");
  const say: Say = (text, type) =>
    paintStatus(statusEl, "checkin-status", text, type);

  const allOptions = () => [
    ...listbox.querySelectorAll<HTMLElement>("[role='option']"),
  ];

  /** Opens or closes the result list, telling a screen reader either way. */
  const setListOpen = (open: boolean) => {
    listbox.classList.toggle("hidden", !open);
    input.setAttribute("aria-expanded", String(open));
  };

  /** The page's state: each shown option's person, the places each option
   * shows, and the person the door picked, or null while the next submit
   * searches. */
  const state: {
    personByOption: Map<Element, Person>;
    picked: Person | null;
  } = { personByOption: new Map(), picked: null };

  /** One person's label: their name, the tickets they still owe, and the
   * details that tell two people with the same name apart. */
  const personLabel = (person: Person, remaining: number): string => {
    const detail = person.details.join(", ");
    const tickets = wording.ticketCount(remaining);
    return detail
      ? wording.fill("ticketOptionDetail", {
          detail,
          name: person.name,
          tickets,
        })
      : wording.fill("ticketOption", { name: person.name, tickets });
  };

  /** Word the submit button for what the next submit does. */
  const setPicked = (person: Person | null) => {
    state.picked = person;
    submitLabel.textContent = wording.word(
      person ? "checkInButton" : "searchButton",
    );
  };

  const selectOption = (opt: HTMLElement) => {
    const person = requiredMapValue(state.personByOption, opt);
    setPicked(person);
    input.value = personLabel(person, Number(opt.dataset.quantity));
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
    const target = e.target as Node;
    if (!input.contains(target) && !listbox.contains(target)) {
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

  /** Relabel one option with the tickets its person still owes. */
  const relabelOption = (opt: HTMLElement, remaining: number) => {
    opt.dataset.quantity = String(remaining);
    opt.textContent = personLabel(
      requiredMapValue(state.personByOption, opt),
      remaining,
    );
  };

  /** Show what one search found as the options the door picks from. */
  const showFound = (people: Person[]) => {
    state.personByOption = new Map();
    listbox.replaceChildren(
      ...people.map((person) => {
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.tabIndex = 0;
        opt.dataset.key = person.key;
        state.personByOption.set(opt, person);
        relabelOption(opt, person.quantity);
        return opt;
      }),
    );
  };

  /** A person the door still owes tickets keeps their option. The option
   * shows what is left: part of a party, or listings a scan did not cover. */
  const showRemaining = (key: string, remaining: number) => {
    for (const opt of allOptions().filter((o) => o.dataset.key === key)) {
      if (remaining > 0) relabelOption(opt, remaining);
      else opt.remove();
    }
  };

  /** Check in one person the search route found. Answers whether the door
   * is done with the pick. A check-in or a declined ask ends the pick. Any
   * other answer leaves it for another try. */
  const checkInById = async (attendeeId: number): Promise<boolean> => {
    const settled = await settleLiveScan(
      (given) =>
        postScanBody(scanPath, csrfToken, {
          ...given,
          attendee_id: attendeeId,
        }),
      { say, wording },
    );
    if (settled.declined) return true;
    const { answer } = settled;
    if (answer.status !== "checked_in") return false;
    showRemaining(String(attendeeId), answer.remaining);
    return true;
  };

  /** Search by the typed name and show what the search found. */
  const search = async () => {
    const text = input.value.trim();
    if (text.length < SEARCH_MIN_LENGTH) {
      say(wording.word("searchTooShort"), "warning");
      return;
    }
    const found = await findPeople(text, {
      checkInById,
      offline,
      say,
      scanPath,
      wording,
    });
    showFound(found ?? []);
    if (found === null) return;
    if (found.length === 0) {
      say(wording.word("searchNone"), "warning");
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
    const picked = state.picked;
    await (picked === null ? search() : settlePick(picked)).catch(
      failLoudly(wording, say),
    );
    submitBtn.disabled = false;
  });
};
