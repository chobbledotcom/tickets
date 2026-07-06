/**
 * The two kinds of error-styled box, kept deliberately distinct.
 *
 * {@link ErrorAlert} is a *live* error — a validation or action failure the
 * operator just triggered. It is announced assertively (`role="alert"`), fades
 * in (the `.error[role="alert"]` keyframe in style.scss), and is focusable
 * (`tabindex="-1"` + `autofocus`) so the browser focuses the first one on the
 * page and scrolls straight to it — the no-JavaScript "jump to the error".
 *
 * {@link ErrorNote} is a *standing* note styled like an error — a persistent
 * caution or status (the money-ledger warning, a "set a business email"
 * prompt, a deactivated-listing banner). It is not a live alert: no
 * `role="alert"`, so it is neither announced assertively, animated on load, nor
 * a focus/scroll target.
 *
 * Because only the first `autofocus` element on a page takes focus and alerts
 * render in document order, a failed submit lands on the topmost live error.
 * A form field that autofocuses *above* an error must give up its autofocus
 * when an error is present, or it would win that race.
 */

import type { Child } from "#shared/jsx/jsx-runtime.ts";

/** A live error alert: focusable, announced, and animated. See the file header. */
export const ErrorAlert = ({ children }: { children?: Child }): JSX.Element => (
  <div autofocus class="error" role="alert" tabindex="-1">
    {children}
  </div>
);

/** A standing note styled like an error: calm, not a focus target. See the
 * file header. */
export const ErrorNote = ({ children }: { children?: Child }): JSX.Element => (
  <div class="error">{children}</div>
);
