/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/** Scroll-hide nav: once the sticky main nav is "stuck" (scrolled past its
 * natural place), hide it while scrolling down and show it again on scroll up;
 * while it is still in its natural place near the top of the page, leave it put.
 *
 * "Stuck" is detected from the live bounding rect — its top reaching the sticky
 * offset — rather than from offsetTop. On a `position: sticky` element offsetTop
 * reports the *stuck* position, which tracks scroll, so the previous
 * `scrollY > offsetTop` check was never true and the nav never hid on desktop. */
export const initScrollHideNav = (): void => {
  const nav = document.querySelector<HTMLElement>("#main-nav");
  if (!nav) return;

  // The viewport offset the nav settles at once stuck (its CSS `top`, e.g.
  // 1rem). Resolves to 0 where the nav isn't sticky (mobile) — harmless there,
  // since the .nav-hidden styles only apply at the sticky breakpoint.
  const stuckTop = Number.parseFloat(getComputedStyle(nav).top) || 0;

  if (location.hash) {
    nav.classList.add("nav-no-transition", "nav-hidden");
    requestAnimationFrame(() => {
      nav.classList.remove("nav-no-transition");
    });
  }
  let lastY = scrollY;
  let ticking = false;
  document.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = scrollY;
        const stuck = nav.getBoundingClientRect().top <= stuckTop + 1;
        nav.classList.toggle("nav-hidden", stuck && y > lastY);
        lastY = y;
        ticking = false;
      });
    },
    { passive: true },
  );
};
