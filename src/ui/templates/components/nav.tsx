/**
 * Shared nav shells for the two site navigations (admin and public), which
 * render the same stacked-bars-on-mobile / pinned-sidebar-on-desktop pattern
 * from the same CSS (`admin-nav--mobile` / `admin-nav--desktop`; the
 * `.admin-nav-group` wrapper is what the desktop grid pins left).
 */

/** One mobile nav bar (the top-level row, or a submenu level beneath it), with
 * an accessible name so screen-reader users can tell the stacked bars apart. */
export const mobileNavBar = (
  label: string,
  lis: JSX.Element[],
): JSX.Element => (
  <nav aria-label={label} class="admin-nav admin-nav--mobile">
    <ul>{lis}</ul>
  </nav>
);

/** The desktop sidebar shell around the top-level `<li>`s. `id` is the admin
 * nav's `#main-nav` marker — the stylesheet reads it as "this is an admin
 * page", so the public nav must not pass one. */
export const desktopNavShell = (
  label: string,
  lis: JSX.Element[],
  id?: string,
): JSX.Element => (
  <nav aria-label={label} class="admin-nav admin-nav--desktop" id={id}>
    <ul>{lis}</ul>
  </nav>
);
