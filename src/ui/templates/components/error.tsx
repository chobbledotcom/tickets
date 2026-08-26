/**
 * The two kinds of error-styled box, kept deliberately distinct.
 *
 * {@link ErrorAlert} is a *live* error — a validation or action failure the
 * operator just triggered. It is announced assertively (`role="alert"`), fades
 * in (the `.error[role="alert"]` keyframe in style.scss), and is focusable
 * (`tabindex="-1"` + `autofocus`) so the browser focuses the first one on the
 * page and scrolls straight to it: the no-JavaScript "jump to the error".
 * {@link ErrorNote} is a *standing* note styled like an error — a persistent
 * caution or status. It is not a live alert: no `role="alert"`, so it is
 * neither announced assertively, animated on load, nor a focus target.
 *
 * Only the first `autofocus` element on a page takes focus, so a form field
 * that autofocuses *above* an error must give up its autofocus when an error is
 * present, or it would win that race.
 */

import type { Child } from "#jsx/jsx-runtime.ts";

/** The shared shape of both error boxes: just the message to show inside. */
type ErrorBoxProps = { children?: Child };

/** A live error alert: focusable, announced, and animated. See the file header. */
export const ErrorAlert = ({ children }: ErrorBoxProps): JSX.Element => (
  <div autofocus class="error" role="alert" tabindex="-1">
    {children}
  </div>
);

/** A standing note styled like an error: calm, not a focus target. See the
 * file header. */
export const ErrorNote = ({ children }: ErrorBoxProps): JSX.Element => (
  <div class="error">{children}</div>
);
