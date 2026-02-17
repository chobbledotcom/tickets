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
  parentScript.src = `${origin}/iframe-resizer-parent.js`;
  parentScript.async = true;
  parentScript.fetchPriority = "high";

  let scriptLoaded = false;
  let iframeLoaded = false;

  const initResize = () => {
    if (!scriptLoaded || !iframeLoaded) return;
    const iframeResize = (window as unknown as {
      iframeResize: (options: {
        license: string;
        onMessage?: (data: { iframe: HTMLIFrameElement; message: Record<string, unknown> }) => void;
      }, target: HTMLIFrameElement) => void;
    }).iframeResize;
    iframeResize({
      license: "GPLv3",
      onMessage: ({ iframe: iframeEl, message }) => {
        if (message?.type === "scrollIntoView") {
          iframeEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      },
    }, iframe);
  };

  parentScript.onload = () => {
    scriptLoaded = true;
    initResize();
  };

  iframe.onload = () => {
    iframeLoaded = true;
    initResize();
  };

  script.after(iframe, parentScript);
})();
