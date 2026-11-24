/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Manual check-in: a search by name, then a pick from what it found. A
 * submit with nobody picked searches. A submit with a person picked checks
 * them in, through the scan JSON API or the offline queue. No step reloads
 * the page, so the camera keeps running. */

import {
  type Found,
  findPeople,
  foundFacts,
  type ManualOffline,
  SEARCH_MIN_LENGTH,
} from "#src/ui/client/admin/manual-search.ts";
import { showConfirm } from "#src/ui/client/confirm-dialog.ts";
import { showQuantitySelect } from "#src/ui/client/quantity-select.ts";

type OptionDirection = "up" | "down";

/** What the scan API answers a door. */
type ScanAnswer = {
  error?: string;
  listingName?: unknown;
  max?: unknown;
  message?: string;
  name?: string;
  quantity?: unknown;
  remaining?: unknown;
  status?: string;
  total?: unknown;
};

const KEY_DIRECTIONS: Partial<Record<string, OptionDirection>> = {
  ArrowDown: "down",
  ArrowUp: "up",
};

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

  const allOptions = () =>
    listbox.querySelectorAll<HTMLLIElement>("[role='option']");

  /** Opens or closes the suggestion list, telling a screen reader either way. */
  const setListOpen = (open: boolean) => {
    listbox.classList.toggle("hidden", !open);
    input.setAttribute("aria-expanded", String(open));
  };

  const filterOptions = () => {
    const query = input.value.toLowerCase();
    let anyVisible = false;
    for (const opt of allOptions()) {
      const text = (opt.textContent ?? "").toLowerCase();
      const visible = text.includes(query);
      opt.classList.toggle("hidden", !visible);
      if (visible) anyVisible = true;
    }
    setListOpen(anyVisible && document.activeElement === input);
  };

  /** Each option's person, so a pick reads what the search found. */
  const foundByOption = new WeakMap<Element, Found>();

  /** The person the door picked, or null while the next submit searches. */
  let picked: Found | null = null;

  /** Word the submit button for what the next submit does. */
  const setPicked = (found: Found | null) => {
    picked = found;
    const label = submitBtn.querySelector("span");
    if (label) {
      label.textContent = found
        ? getMessage("messageCheckInButton", "Check In")
        : getMessage("messageSearchButton", "Search");
    }
  };

  const selectOption = (opt: HTMLLIElement) => {
    setPicked(foundByOption.get(opt) ?? null);
    const detail = opt.dataset.detail ?? "";
    input.value =
      `${opt.dataset.name} (${formatTicketCount(Number(opt.dataset.quantity))})` +
      (detail ? ` — ${detail}` : "");
    setListOpen(false);
  };

  input.addEventListener("input", () => {
    setPicked(null);
    filterOptions();
  });

  input.addEventListener("focus", () => {
    filterOptions();
  });

  // Hide list on outside click
  document.addEventListener("click", (e) => {
    if (
      !input.contains(e.target as Node) &&
      !listbox.contains(e.target as Node)
    ) {
      setListOpen(false);
    }
  });

  const getVisibleOptions = () => [
    ...listbox.querySelectorAll<HTMLLIElement>("[role='option']:not(.hidden)"),
  ];

  const getActiveOption = () =>
    listbox.querySelector<HTMLLIElement>("[role='option'].combobox-active");

  const navigateOptions = (direction: OptionDirection) => {
    const visible = getVisibleOptions();
    if (visible.length === 0) return;
    const active = getActiveOption();
    const idx = active ? visible.indexOf(active) : -1;
    active?.classList.remove("combobox-active");
    const step = direction === "down" ? 1 : -1;
    const next = visible[(idx + step + visible.length) % visible.length];
    if (next) {
      next.classList.add("combobox-active");
      next.scrollIntoView({ block: "nearest" });
    }
  };

  const handleKeydown = (e: KeyboardEvent) => {
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
  };

  input.addEventListener("keydown", handleKeydown);

  listbox.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLLIElement>(
      "[role='option']",
    );
    if (opt) selectOption(opt);
  });

  const showCheckinStatus = (
    message: string,
    type: "success" | "warning" | "error",
  ) => {
    statusEl.textContent = message;
    statusEl.classList.remove(
      "hidden",
      "checkin-status-success",
      "checkin-status-warning",
      "checkin-status-error",
    );
    statusEl.classList.add("checkin-status", `checkin-status-${type}`);
  };

  /** One scan answer as the message the door reads: who they are, how many
   * places the answer covers, and the listing names that drove it. A part
   * answer names its raw counts, so "(2 of 3 tickets)" reads as counts. */
  const answerValues = (result: {
    listingName?: unknown;
    name?: string;
    quantity?: unknown;
    total?: unknown;
  }): Record<string, string | undefined> => {
    const count = Number.isFinite(result.quantity)
      ? Number(result.quantity)
      : 1;
    const total = Number(result.total);
    const partial = total > count;
    return {
      listingName: String(result.listingName ?? ""),
      name: result.name,
      tickets: partial ? String(count) : formatTicketCount(count),
      ...(partial ? { total: String(total) } : {}),
    };
  };

  const clearPick = () => {
    setPicked(null);
    input.value = "";
  };

  /** Show what one search found as the options the door picks from. */
  const showFound = (found: Found[]) => {
    listbox.replaceChildren(
      ...found.map((person) => {
        const { details, name, quantity } = foundFacts(person);
        const opt = document.createElement("div");
        opt.setAttribute("role", "option");
        opt.tabIndex = 0;
        if (person.kind === "online") {
          opt.dataset.attendeeId = String(person.attendeeId);
        }
        opt.dataset.detail = details.join(", ");
        opt.dataset.name = name;
        relabelOption(opt, quantity);
        foundByOption.set(opt, person);
        return opt;
      }),
    );
  };

  /** Relabel one option with the tickets its person still owes. */
  function relabelOption(opt: HTMLElement, remaining: number) {
    opt.dataset.quantity = String(remaining);
    const detail = opt.dataset.detail;
    opt.textContent = interpolate(
      detail
        ? getMessage(
            "messageTicketOptionDetail",
            "{name} ({tickets}) — {detail}",
          )
        : getMessage("messageTicketOption", "{name} ({tickets})"),
      { detail, name: opt.dataset.name, tickets: formatTicketCount(remaining) },
    );
  }

  /** A person the door still owes tickets keeps their option. The option
   * shows what is left: part of a party, or listings a scan did not cover. */
  const showRemaining = (attendeeId: string, remaining: number) => {
    for (const opt of allOptions()) {
      if (opt.dataset.attendeeId !== attendeeId) continue;
      if (remaining > 0) relabelOption(opt, remaining);
      else opt.remove();
    }
  };

  const handleCheckedIn = (
    result: {
      listingName?: unknown;
      name: string;
      quantity?: unknown;
      remaining?: unknown;
      total?: unknown;
    },
    attendeeId: string,
    idVerified: boolean,
  ) => {
    const idNote = idVerified
      ? getMessage("messageVerifyIdNote", " — verify their ID")
      : "";
    const partial = Number(result.total) > Number(result.quantity);
    showCheckinStatus(
      `${interpolate(
        getMessage(
          partial ? "messageCheckedInPartial" : "messageCheckedIn",
          "{name} checked in for {listingName} ({tickets})",
        ),
        answerValues(result),
      )}${idNote}`,
      "success",
    );
    showRemaining(attendeeId, Number(result.remaining));
    clearPick();
  };

  /** Say the door sent this person away without checking them in. */
  const skipPerson = (name: unknown) => {
    showCheckinStatus(
      interpolate(getMessage("messageSkipped", "Skipped {name}"), { name }),
      "warning",
    );
    clearPick();
  };

  /** Whether a scan answer asks the door something it has not answered. */
  const needsAsk = (
    result: { status?: string },
    given: Record<string, unknown>,
  ): boolean =>
    (result.status === "verify_id" && !given.id_verified) ||
    (result.status === "select_quantity" && given.quantity === undefined);

  /** Ask the door the one question a scan answer needs, and return the
   * choice to re-post, or null when the door declined. A non-transferable
   * listing needs the door to look at the person's ID and say so — never
   * assert it from the name pick alone. A ticket that owes more than one
   * place asks how many to admit, capped by what the lines owe. */
  const askDoor = async (result: {
    max?: unknown;
    name?: unknown;
    status?: string;
  }): Promise<Record<string, unknown> | null> => {
    if (result.status === "verify_id") {
      const confirmed = await showConfirm(
        interpolate(
          getMessage("messageVerifyIdConfirm", 'Does their ID match "{name}"?'),
          { name: result.name },
        ),
      );
      return confirmed ? { id_verified: true } : null;
    }
    const count = await showQuantitySelect(
      Number(result.max),
      interpolate(
        getMessage("messageSelectQuantity", "How many tickets for {name}?"),
        { name: result.name },
      ),
      formatTicketCount,
    );
    return count === null ? null : { quantity: count };
  };

  const dispatchScanResult = (
    result: {
      listingName?: unknown;
      status?: string;
      name?: string;
      message?: string;
      error?: string;
      quantity?: unknown;
    },
    attendeeId: string,
    idVerified: boolean,
  ) => {
    if (result.status === "checked_in") {
      handleCheckedIn(
        result as { name: string; quantity?: unknown },
        attendeeId,
        idVerified,
      );
    } else if (result.status === "already_checked_in") {
      showCheckinStatus(
        interpolate(
          getMessage(
            "messageAlreadyCheckedIn",
            "{name} already checked in for {listingName} ({tickets})",
          ),
          answerValues(result),
        ),
        "warning",
      );
    } else if (result.status === "refunded") {
      showCheckinStatus(
        interpolate(getMessage("messageRefunded", "{name} has been refunded"), {
          name: result.name,
        }),
        "error",
      );
    } else if (result.status === "not_found") {
      showCheckinStatus(
        getMessage("messageNotFound", "Ticket not found"),
        "error",
      );
    } else {
      showCheckinStatus(
        result.error ?? result.message ?? getMessage("messageError", "Error"),
        "error",
      );
    }
  };

  /** Settle one pick with the door. Each ask is answered once: the re-post
   * carries every earlier answer, so a verified ID still stands when the
   * door then picks a count. */
  const checkInPick = async (
    attendeeId: string,
    postScan: (body: Record<string, unknown>) => Promise<ScanAnswer>,
  ) => {
    const attendeeIdNumber = Number(attendeeId);
    let given: Record<string, unknown> = {};
    let result = await postScan({ attendee_id: attendeeIdNumber });
    while (needsAsk(result, given)) {
      const choice = await askDoor(result);
      if (!choice) {
        skipPerson(result.name);
        return;
      }
      given = { ...given, ...choice };
      result = await postScan({ attendee_id: attendeeIdNumber, ...given });
    }
    dispatchScanResult(result, attendeeId, given.id_verified === true);
  };

  const postScan = async (
    body: Record<string, unknown>,
  ): Promise<ScanAnswer> => {
    const r = await fetch(scanPath, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfInput.value,
      },
      method: "POST",
    });
    return r.json();
  };

  /** Search by the typed name and show what the search found. */
  const search = async () => {
    const text = input.value.trim();
    if (text.length < SEARCH_MIN_LENGTH) {
      showCheckinStatus(
        getMessage(
          "messageSearchTooShort",
          "Type at least 2 letters of the name.",
        ),
        "warning",
      );
      return;
    }
    const found = await findPeople(
      text,
      scanPath,
      offline,
      showCheckinStatus,
      getMessage(
        "messageSearchFailed",
        "The search did not work. Check your connection, then try again.",
      ),
    );
    showFound(found ?? []);
    if (found === null) return;
    if (found.length === 0) {
      showCheckinStatus(
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

  /** Settle the door's pick: the offline queue takes a saved person, and
   * the scan API takes a person the search route found. */
  const settlePick = async (person: Found) => {
    if (person.kind === "online") {
      await checkInPick(String(person.attendeeId), postScan);
      return;
    }
    clearPick();
    await person.queue(showCheckinStatus);
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    try {
      await (picked === null ? search() : settlePick(picked));
    } catch {
      showCheckinStatus(
        getMessage("messageNetworkError", "Network error"),
        "error",
      );
    } finally {
      submitBtn.disabled = false;
    }
  });
};
