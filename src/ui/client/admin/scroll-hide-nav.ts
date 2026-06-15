/// <reference lib="dom" />
/** Scroll-hide nav: hide sticky main nav on scroll down once it has been
 * scrolled past, show on scroll up or while still within its natural area. */
export const initScrollHideNav = (): void => {
  const nav = document.querySelector<HTMLElement>("#main-nav");
  if (!nav) return;

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
        // Only hide once scrolled past the nav's natural position, so it
        // slides away while already off-screen rather than visibly flying
        // off the top while the user is still near the top of the page.
        const navBottom = nav.offsetTop + nav.offsetHeight;
        nav.classList.toggle("nav-hidden", y > navBottom && y > lastY);
        lastY = y;
        ticking = false;
      });
    },
    { passive: true },
  );
};
