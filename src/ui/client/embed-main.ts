import { initEmbed } from "#src/ui/client/embed.ts";

// The bundle entry: boots the loader for the script tag that shipped it.
const script = document.currentScript as HTMLScriptElement;
if (script) initEmbed(script);
