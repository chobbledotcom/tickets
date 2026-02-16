/// <reference lib="dom" />
/** Embed loader: creates an iframe and wires iframe-resizer. */

(() => {
  const script = document.currentScript as HTMLScriptElement;
  const events = script.dataset.events!.split(/[+,]/);
  const origin = new URL(script.src).origin;
  const iframeSrc = `${origin}/ticket/${events.join("+")}?iframe=true`;
  const title = script.dataset.title ?? "Tickets";

  const iframe = document.createElement("iframe");
  iframe.src = iframeSrc;
  iframe.loading = "lazy";
  iframe.style.border = "none";
  iframe.style.width = "100%";
  iframe.setAttribute("title", title);

  const parentScript = document.createElement("script");
  parentScript.src = script.dataset.resizerSrc!;
  parentScript.async = true;
  parentScript.fetchPriority = "high";
  parentScript.onload = () => {
    const iframeResize = (window as unknown as { iframeResize: (options: { license: string }, target: HTMLIFrameElement) => void })
      .iframeResize;
    iframeResize({ license: script.dataset.license || "GPLv3" }, iframe);
  };

  script.after(iframe, parentScript);
})();
