/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { buildEmbedSnippets } from "#shared/embed.ts";

/** Multi-booking link builder: track checkbox selection order and
 * render a combined URL + embed snippets once 2+ listings are selected. */
export const initMultiBookingBuilder = (): void => {
  const multiUrl = document.querySelector<HTMLInputElement>(
    "[data-multi-booking-url]",
  );
  if (!multiUrl) return;

  const multiEmbedScript = document.querySelector<HTMLInputElement>(
    "[data-multi-booking-embed-script]",
  )!;
  const multiEmbedIframe = document.querySelector<HTMLInputElement>(
    "[data-multi-booking-embed-iframe]",
  )!;
  const selectedSlugs: string[] = [];
  const domain = multiUrl.dataset.domain!;
  const urlPlaceholder = multiUrl.placeholder;
  const embedScriptPlaceholder = multiEmbedScript.placeholder;
  const embedIframePlaceholder = multiEmbedIframe.placeholder;

  for (const cb of document.querySelectorAll<HTMLInputElement>(
    "[data-multi-booking-slug]",
  )) {
    cb.addEventListener("change", () => {
      const slug = cb.dataset.multiBookingSlug!;
      if (cb.checked) {
        selectedSlugs.push(slug);
      } else {
        const idx = selectedSlugs.indexOf(slug);
        if (idx !== -1) {
          selectedSlugs.splice(idx, 1);
        }
      }
      if (selectedSlugs.length >= 2) {
        const url = `https://${domain}/ticket/${selectedSlugs.join("+")}`;
        multiUrl.value = url;
        multiUrl.placeholder = "";
        const { script, iframe } = buildEmbedSnippets(url);
        multiEmbedScript.value = script;
        multiEmbedIframe.value = iframe;
        multiEmbedScript.placeholder = "";
        multiEmbedIframe.placeholder = "";
      } else {
        multiUrl.value = "";
        multiUrl.placeholder = urlPlaceholder;
        multiEmbedScript.value = "";
        multiEmbedIframe.value = "";
        multiEmbedScript.placeholder = embedScriptPlaceholder;
        multiEmbedIframe.placeholder = embedIframePlaceholder;
      }
    });
  }
};
