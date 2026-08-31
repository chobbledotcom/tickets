/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { csrfPost } from "./csrf.ts";

/** The answer a connection-test endpoint returns: whether the connection
 * passed, and the lines to show — words the server rendered from the
 * message catalog, so this script holds no copy of its own. */
interface ConnectionAnswer {
  lines: string[];
  ok: boolean;
}

/** Show the result box with the given text, coloured green for a pass and red
 * for a failure. */
const showTestResult = (
  resultDiv: HTMLElement,
  text: string,
  passed: boolean,
  cssClass: string,
) => {
  resultDiv.textContent = text;
  // The click cleared the last answer's colour before asking, so the box only
  // needs showing again.
  resultDiv.classList.remove("hidden");
  resultDiv.classList.add(passed ? "success" : "error", cssClass);
};

/** Wire up one payment provider's "Test Connection" button. The provider's
 * own name gives the two element ids, the result class and the test address,
 * so the page and this script cannot disagree about any of them. The page
 * also owns every label: the answer's words come from the server, and the
 * testing and failure labels ride along as data attributes. */
const setupTestButton = (provider: string) => {
  const button = document.getElementById(`${provider}-test-btn`);
  if (!(button instanceof HTMLButtonElement)) return;
  const resultDiv = document.getElementById(`${provider}-test-result`);
  if (resultDiv === null) return;
  // The page owns the button label, so keep its own words to put back.
  const label = button.textContent;
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = button.dataset.testing ?? label;
    resultDiv.classList.add("hidden");
    resultDiv.classList.remove("success", "error");
    try {
      const csrfInput = button
        .closest("form")
        ?.querySelector<HTMLInputElement>('input[name="csrf_token"]');
      const answer: ConnectionAnswer = await csrfPost(
        `/admin/settings/${provider}/test`,
        csrfInput?.value ?? "",
      );
      showTestResult(
        resultDiv,
        answer.lines.join("\n"),
        answer.ok,
        `${provider}-test-result`,
      );
    } catch (e) {
      showTestResult(
        resultDiv,
        `${resultDiv.dataset.failed} ${
          e instanceof Error ? e.message : "Unknown error"
        }`,
        false,
        `${provider}-test-result`,
      );
    }
    button.disabled = false;
    button.textContent = label;
  });
};

/** Wire up the "Test Connection" button of every payment provider that has
 * one on the admin settings page. */
export const initPaymentTestButtons = (): void => {
  for (const provider of ["square", "stripe", "sumup"]) {
    setupTestButton(provider);
  }
};
