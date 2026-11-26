/** The camera link plays the CDN guide video in the admin modal. The recordings
 * are silent, so the player autoplays muted; without this script the link still
 * opens the MP4 in a new tab. */

import { openAdminModal } from "./modal.ts";

const GUIDE_VIDEO_SELECTOR = "a[data-guide-video]";

const guideVideo = (src: string, title: string): HTMLVideoElement => {
  const video = document.createElement("video");
  video.autoplay = true;
  video.className = "guide-video-player";
  video.controls = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.setAttribute("referrerpolicy", "no-referrer");
  video.src = src;
  video.title = title;
  return video;
};

const openGuideVideo = (link: HTMLAnchorElement): void => {
  const title = link.dataset.guideTitle ?? link.title;
  openAdminModal(
    { collapsedTitle: title, key: `guide-video:${link.href}`, title },
    guideVideo(link.href, title),
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
