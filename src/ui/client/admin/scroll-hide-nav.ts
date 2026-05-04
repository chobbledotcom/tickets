/// <reference lib="dom" />
/** Scroll-hide nav: hide sticky main nav on scroll down, show on scroll up or at top. */
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
        nav.classList.toggle("nav-hidden", y > 0 && y > lastY);
        lastY = y;
        ticking = false;
      });
    },
    { passive: true },
  );
};
