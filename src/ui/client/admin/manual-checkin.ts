/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Manual check-in: custom combobox + fetch-based form submission.
 * Posts to the scan JSON API without a page reload so the camera keeps running. */
import { showQuantitySelect } from "#src/ui/client/quantity-select.ts";

type OptionDirection = "up" | "down";

const KEY_DIRECTIONS: Partial<Record<string, OptionDirection>> = {
  ArrowDown: "down",
  ArrowUp: "up",
};

export const initManualCheckin = (): void => {
  const form = document.querySelector<HTMLFormElement>("[data-manual-checkin]");
  if (!form) return;

  const input = form.querySelector<HTMLInputElement>("#manual-checkin-input")!;
  const tokenInput = document.getElementById(
    "manual-checkin-token",
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
    tokenInput.value = opt.dataset.token!;
    input.value = `${opt.dataset.name} (${formatTicketCount(Number(opt.dataset.quantity))})`;
    setListOpen(false);
  };

  input.addEventListener("input", () => {
    tokenInput.value = "";
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

  const handleCheckedIn = (
    result: {
      listingName?: unknown;
      name: string;
      quantity?: unknown;
      remaining?: unknown;
      total?: unknown;
    },
    token: string,
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
    // A person the door still owes tickets keeps their option, showing
    // what is left: part of a party, or listings a scan did not cover.
    const remaining = Number(result.remaining);
    for (const opt of allOptions()) {
      if (opt.dataset.token !== token) continue;
      if (!(remaining > 0)) {
        opt.remove();
        continue;
      }
      opt.dataset.quantity = String(remaining);
      opt.textContent = interpolate(
        getMessage("messageTicketOption", "{name} ({tickets}) — {token}"),
        {
          name: opt.dataset.name,
          tickets: formatTicketCount(remaining),
          token,
        },
      );
    }
    tokenInput.value = "";
    input.value = "";
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
    token: string,
    idVerified: boolean,
  ) => {
    if (result.status === "checked_in") {
      handleCheckedIn(
        result as { name: string; quantity?: unknown },
        token,
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) return;

    const submitBtn = form.querySelector<HTMLButtonElement>(
      'button[type="submit"]',
    )!;
    submitBtn.disabled = true;

    const postScan = async (body: Record<string, unknown>) => {
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
      let result = await postScan({ token });

      // Non-transferable listing: re-submit with id_verified since the
      // admin already identified the attendee via the autocomplete list.
      let idVerified = false;
      if (result.status === "verify_id") {
        idVerified = true;
        result = await postScan({ id_verified: true, token });
      }

      // A ticket that owes more than one place asks how many to admit.
      // The pick goes through the same scan, capped by what the lines owe.
      let cancelled = false;
      if (result.status === "select_quantity") {
        const count = await showQuantitySelect(
          Number(result.max),
          interpolate(
            getMessage("messageSelectQuantity", "How many tickets for {name}?"),
            { name: result.name },
          ),
          formatTicketCount,
        );
        if (count === null) {
          cancelled = true;
          showCheckinStatus(
            interpolate(getMessage("messageSkipped", "Skipped {name}"), {
              name: result.name,
            }),
            "warning",
          );
        } else {
          result = await postScan({
            id_verified: idVerified,
            quantity: count,
            token,
          });
        }
      }

      if (!cancelled) dispatchScanResult(result, token, idVerified);
    } catch {
      showCheckinStatus(
        getMessage("messageNetworkError", "Network error"),
        "error",
      );
    }

    submitBtn.disabled = false;
  });
};
