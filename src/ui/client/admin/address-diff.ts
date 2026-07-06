/// <reference lib="dom" />
/**
 * "The chosen address differs from what's typed" notice — when a postcode
 * search result replaces a hand-typed address, this shows the chosen line
 * with the words that were not in the typed address highlighted, so the
 * operator can see at a glance what the search corrected.
 *
 * Rendered into the Logistics tab's `[data-address-diff]` output (its
 * heading copy comes server-translated in `data-diff-heading`); pages
 * without that element simply skip the notice.
 */

/** A run of consecutive words that are all changed or all unchanged. */
export type DiffRun = { text: string; changed: boolean };

/** A word stripped down for comparison: case and punctuation don't count. */
const comparableWord = (word: string): string =>
  word.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Split the chosen address into runs, marking each word that does not appear
 * anywhere in the typed address. Word-set comparison (not position) keeps
 * reordered parts unmarked — only genuinely new words light up.
 */
export const diffAddressWords = (typed: string, chosen: string): DiffRun[] => {
  const typedWords = new Set(
    typed.split(/\s+/).map(comparableWord).filter(Boolean),
  );
  const runs: DiffRun[] = [];
  for (const word of chosen.split(/\s+/).filter(Boolean)) {
    const changed = !typedWords.has(comparableWord(word));
    const last = runs[runs.length - 1];
    if (last && last.changed === changed) {
      last.text = `${last.text} ${word}`;
    } else {
      runs.push({ changed, text: `${word}` });
    }
  }
  return runs;
};

/** One rendered run: a <mark> for changed words, a plain <span> otherwise.
 * The trailing space keeps the words apart between elements. */
const runElement = (run: DiffRun): HTMLElement => {
  const element = document.createElement(run.changed ? "mark" : "span");
  element.textContent = `${run.text} `;
  return element;
};

/**
 * Show (or hide) the differences notice after a search result was chosen.
 * Nothing to say — no notice element, nothing previously typed, or an
 * identical choice — hides it.
 */
export const renderAddressDiff = (typed: string, chosen: string): void => {
  const output = document.querySelector<HTMLElement>("[data-address-diff]");
  if (!output) return;
  const runs = diffAddressWords(typed, chosen);
  const changed = runs.some((run) => run.changed);
  if (!typed.trim() || !changed) {
    output.hidden = true;
    return;
  }
  const heading = document.createElement("strong");
  heading.textContent = `${output.dataset.diffHeading ?? ""} `;
  output.replaceChildren(heading, ...runs.map(runElement));
  output.hidden = false;
};
