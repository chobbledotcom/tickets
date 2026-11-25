/** The camera link opens the CDN guide animation in the admin modal. Without
 * this script the link still opens the animation in a new tab. */

import { openAdminModal } from "./modal.ts";

const GUIDE_VIDEO_SELECTOR = "a[data-guide-video]";

const openGuideVideo = (link: HTMLAnchorElement): void => {
  const title = link.dataset.guideTitle ?? link.title;
  const iframe = document.createElement("iframe");
  iframe.className = "guide-video-frame";
  iframe.src = link.href;
  iframe.title = title;
  iframe.setAttribute("allow", "fullscreen");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  openAdminModal(
    { collapsedTitle: title, key: `guide-video:${link.href}`, title },
    iframe,
  );
};

export const initGuideVideoLinks = (): void => {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>(GUIDE_VIDEO_SELECTOR);
    if (link === null) return;
    event.preventDefault();
    openGuideVideo(link);
  });
};
