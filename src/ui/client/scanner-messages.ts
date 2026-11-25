/// <reference lib="dom" />
/** How a scanner page shows one outcome to the door. The camera's status
 * sits over the video and fades out after a success or a warning. The
 * manual check-in's status sits under its form. Both paint the same way,
 * each with its own class prefix. */

/** The kind of one outcome, which picks its colour. */
export type StatusType = "success" | "warning" | "error";

/** How a page reports one outcome to the door. */
export type Say = (text: string, type: StatusType) => void;

/** How long a camera status stays before it fades, in milliseconds. */
export const FADE_DELAY_MS = 5000;

const STATUS_TYPES: readonly StatusType[] = ["success", "warning", "error"];

/** Paint one outcome on a status element whose classes start with
 * `prefix`. */
export const paintStatus = (
  el: HTMLElement,
  prefix: string,
  text: string,
  type: StatusType,
): void => {
  el.textContent = text;
  el.classList.remove(
    "hidden",
    `${prefix}-fade-out`,
    ...STATUS_TYPES.map((kind) => `${prefix}-${kind}`),
  );
  el.classList.add(prefix, `${prefix}-${type}`);
};

const fade = { timer: 0 };

/** Show one outcome on the camera's status. A success or a warning fades
 * out after `FADE_DELAY_MS`. An error stays until the next outcome. */
export const showStatus = (
  el: HTMLElement,
  text: string,
  type: StatusType,
): void => {
  clearTimeout(fade.timer);
  paintStatus(el, "scanner-status", text, type);
  if (type !== "error") {
    fade.timer = setTimeout(() => {
      el.classList.add("scanner-status-fade-out");
    }, FADE_DELAY_MS);
  }
};
