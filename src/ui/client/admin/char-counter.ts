/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Remaining chars counter for textareas with maxlength. */
export const initCharCounters = (): void => {
  for (const ta of document.querySelectorAll<HTMLTextAreaElement>(
    "textarea[maxlength]",
  )) {
    const max = Number(ta.getAttribute("maxlength"));
    if (!max) continue;
    const counter = document.createElement("small");
    counter.className = "char-counter";
    const update = () => {
      const remaining = max - ta.value.length;
      counter.textContent = `${remaining} / ${max}`;
      counter.classList.toggle("char-counter-warn", remaining < max * 0.1);
    };
    update();
    ta.addEventListener("input", update);
    ta.parentNode!.insertBefore(counter, ta.nextSibling);
  }
};
