/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Either/or pairs declared in markup: while one control of a pair holds, the
 *  other renders disabled with the refusal that explains the boundary. The
 *  server-side save keeps its refusal as the authority; this is the affordance
 *  that turns it into an obvious hint before the operator submits. */
export const initPairedControls = (): void => {
  const controls = document.querySelectorAll<HTMLInputElement>(
    "input[data-exclusive-with]",
  );
  const counterpartOf = (control: HTMLInputElement) => {
    // The map selector guarantees the attribute, so the name is always text.
    const matches = document.getElementsByName(
      control.dataset.exclusiveWith as string,
    );
    return matches.length === 0 ? null : (matches[0] as HTMLInputElement);
  };

  const whyHolder = (control: HTMLInputElement): HTMLElement => {
    const label = control.closest("label");
    const existing = label?.querySelector(".exclusive-why");
    if (existing !== null && existing !== undefined) {
      return existing as HTMLElement;
    }
    const holder = document.createElement("small");
    holder.className = "exclusive-why";
    holder.textContent = control.dataset.exclusiveWhy ?? "";
    label?.append(holder);
    return holder;
  };

  const updatePair = (a: HTMLInputElement, b: HTMLInputElement) => {
    // Both ticked stays editable, so the operator can resolve a conflict the
    // server re-rendered; one ticked grants the boundary to that side.
    const both = a.checked && b.checked;
    a.disabled = !both && b.checked;
    b.disabled = !both && a.checked;
    whyHolder(a).hidden = both || !a.checked;
    whyHolder(b).hidden = both || !b.checked;
  };

  const wire = (control: HTMLInputElement) => {
    const counterpart = counterpartOf(control);
    if (!counterpart) return;
    control.addEventListener("change", () => updatePair(control, counterpart));
    updatePair(control, counterpart);
  };
  for (const control of controls) wire(control);
};
