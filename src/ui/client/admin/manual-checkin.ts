/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Manual check-in: custom combobox + fetch-based form submission.
 * Posts to the scan JSON API without a page reload so the camera keeps running. */

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

export const initManualCheckin = (): void => {
  const form = document.querySelector<HTMLFormElement>("[data-manual-checkin]");
  if (!form) return;

  const input = form.querySelector<HTMLInputElement>("#manual-checkin-input")!;
  const attendeeIdInput = document.getElementById(
    "manual-checkin-attendee-id",
  ) as HTMLInputElement;
  const listbox = document.getElementById("ticket-options")!;
  const statusEl = document.getElementById("manual-checkin-status")!;
  const scanPath = form.dataset.scanPath!;
  const csrfInput = form.querySelector<HTMLInputElement>(
    'input[name="csrf_token"]',
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

  const selectOption = (opt: HTMLLIElement) => {
    attendeeIdInput.value = opt.dataset.attendeeId!;
    const detail = opt.dataset.detail ?? "";
    input.value =
      `${opt.dataset.name} (${formatTicketCount(Number(opt.dataset.quantity))})` +
      (detail ? ` — ${detail}` : "");
    setListOpen(false);
  };

  input.addEventListener("input", () => {
    attendeeIdInput.value = "";
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
    attendeeIdInput.value = "";
    input.value = "";
  };

  /** Relabel one option with the tickets its person still owes. */
  const relabelOption = (opt: HTMLElement, remaining: number) => {
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
  };

  /** A person the door still owes tickets keeps their option, showing what
   * is left: part of a party, or listings a scan did not cover. */
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const attendeeId = attendeeIdInput.value.trim();
    if (!attendeeId) return;

    const submitBtn = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    submitBtn.disabled = true;

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

    try {
      await checkInPick(attendeeId, postScan);
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
