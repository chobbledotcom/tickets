/// <reference lib="dom" />
/** Manual check-in: custom combobox + fetch-based form submission.
 * Posts to the scan JSON API without a page reload so the camera keeps running. */
export const initManualCheckin = (): void => {
  const form = document.querySelector<HTMLFormElement>("[data-manual-checkin]");
  if (!form) return;

  const input = form.querySelector<HTMLInputElement>("#manual-checkin-input")!;
  const tokenInput = document.getElementById(
    "manual-checkin-token",
  ) as HTMLInputElement;
  const listbox = document.getElementById("ticket-options")!;
  const statusEl = document.getElementById("manual-checkin-status")!;
  const eventId = form.dataset.eventId!;
  const csrfInput = form.querySelector<HTMLInputElement>(
    'input[name="csrf_token"]',
  )!;

  const allOptions = () =>
    listbox.querySelectorAll<HTMLLIElement>("[role='option']");

  const showList = () => {
    listbox.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
  };
  const hideList = () => {
    listbox.classList.add("hidden");
    input.setAttribute("aria-expanded", "false");
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
    if (anyVisible && document.activeElement === input) showList();
    else hideList();
  };

  const selectOption = (opt: HTMLLIElement) => {
    tokenInput.value = opt.dataset.token!;
    input.value = `${opt.dataset.name} (${opt.dataset.quantity} ticket${opt.dataset.quantity === "1" ? "" : "s"})`;
    hideList();
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
      hideList();
    }
  });

  // Keyboard navigation
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideList();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const visible = [
        ...listbox.querySelectorAll<HTMLLIElement>(
          "[role='option']:not(.hidden)",
        ),
      ];
      if (visible.length === 0) return;
      const active = listbox.querySelector<HTMLLIElement>(
        "[role='option'].combobox-active",
      );
      const idx = active ? visible.indexOf(active) : -1;
      active?.classList.remove("combobox-active");
      const next =
        e.key === "ArrowDown"
          ? visible[(idx + 1) % visible.length]
          : visible[(idx - 1 + visible.length) % visible.length];
      if (next) {
        next.classList.add("combobox-active");
        next.scrollIntoView({ block: "nearest" });
      }
    }
    if (e.key === "Enter") {
      const active = listbox.querySelector<HTMLLIElement>(
        "[role='option'].combobox-active",
      );
      if (active) {
        e.preventDefault();
        selectOption(active);
      }
    }
  });

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

  const handleCheckedIn = (
    result: { name: string; quantity?: unknown },
    token: string,
    idVerified: boolean,
  ) => {
    const qty = Number.isFinite(result.quantity)
      ? (result.quantity as number)
      : 1;
    const idNote = idVerified ? " — verify their ID" : "";
    showCheckinStatus(
      `${result.name} checked in (${qty} ticket${qty === 1 ? "" : "s"})${idNote}`,
      "success",
    );
    for (const opt of allOptions()) {
      if (opt.dataset.token === token) {
        opt.remove();
        break;
      }
    }
    tokenInput.value = "";
    input.value = "";
  };

  const dispatchScanResult = (
    result: {
      status?: string;
      name?: string;
      message?: string;
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
      showCheckinStatus(`${result.name} already checked in`, "warning");
    } else if (result.status === "refunded") {
      showCheckinStatus(`${result.name} has been refunded`, "error");
    } else if (result.status === "not_found") {
      showCheckinStatus("Ticket not found", "error");
    } else {
      showCheckinStatus(result.message ?? "Error", "error");
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
      const r = await fetch(`/admin/event/${eventId}/scan`, {
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

      // Non-transferable event: re-submit with id_verified since the
      // admin already identified the attendee via the autocomplete list.
      let idVerified = false;
      if (result.status === "verify_id") {
        idVerified = true;
        result = await postScan({ id_verified: true, token });
      }

      dispatchScanResult(result, token, idVerified);
    } catch {
      showCheckinStatus("Network error", "error");
    }

    submitBtn.disabled = false;
  });
};
