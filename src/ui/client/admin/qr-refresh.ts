/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Auto-refresh the admin QR result panel every minute so stale links are
 *  obvious to anyone watching the screen. Fades the old QR out (500ms), swaps
 *  in the new SVG + URL, then fades the new one in (500ms). */

const REFRESH_INTERVAL_MS = 60_000;
const FADE_MS = 500;

type RefreshResponseOk = { ok: true; url: string; svg: string };
type RefreshResponseErr = { ok: false; error: string };
type RefreshResponse = RefreshResponseOk | RefreshResponseErr;

/** Build the refresh URL from the admin form's current values */
const buildRefreshUrl = (endpoint: string, form: HTMLFormElement): string => {
  const data = new FormData(form);
  const params = new URLSearchParams();
  for (const key of ["customer_name", "value", "quantity", "date"]) {
    const v = data.get(key);
    if (typeof v === "string" && v) params.set(key, v);
  }
  return `${endpoint}?${params.toString()}`;
};

/** Fade out → swap → fade in. Animates via inline opacity so the page
 *  only needs a single `transition: opacity` CSS rule. */
const swap = (
  panel: HTMLElement,
  svgContainer: HTMLElement,
  linkInput: HTMLInputElement,
  data: RefreshResponseOk,
): Promise<void> => {
  panel.style.opacity = "0";
  return new Promise((resolve) => {
    setTimeout(() => {
      svgContainer.innerHTML = data.svg;
      linkInput.value = data.url;
      panel.style.opacity = "1";
      resolve();
    }, FADE_MS);
  });
};

/** Fetch a new token and swap the panel contents */
const refresh = async (
  endpoint: string,
  form: HTMLFormElement,
  panel: HTMLElement,
  svgContainer: HTMLElement,
  linkInput: HTMLInputElement,
): Promise<void> => {
  const response = await fetch(buildRefreshUrl(endpoint, form), {
    credentials: "same-origin",
  });
  if (!response.ok) return;
  const data = (await response.json()) as RefreshResponse;
  if (data.ok) await swap(panel, svgContainer, linkInput, data);
};

/** Boot the refresher when the result panel is present on the page */
export const initQrRefresh = (): void => {
  const panel = document.querySelector<HTMLElement>("[data-qr-refresh]");
  if (!panel) return;
  const endpoint = panel.dataset.qrRefresh;
  if (!endpoint) return;
  const form = document.querySelector<HTMLFormElement>(
    `form[action="${panel.dataset.qrRefreshForm}"]`,
  );
  const svgContainer = panel.querySelector<HTMLElement>("[data-qr-svg]");
  const linkInput = panel.querySelector<HTMLInputElement>("[data-qr-link]");
  if (!form || !svgContainer || !linkInput) return;
  setInterval(
    () => refresh(endpoint, form, panel, svgContainer, linkInput),
    REFRESH_INTERVAL_MS,
  );
};
