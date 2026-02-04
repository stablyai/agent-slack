import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export function htmlToMarkdown(html: string): string {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });

  service.use(gfm as any);

  // Keep line breaks from <br>
  service.addRule("br", {
    filter: "br",
    replacement: () => "\n",
  });

  // Slack exports sometimes wrap content in <main> / <article>.
  // Turndown handles full documents fine, but prefer the primary content node.
  const extracted =
    extractTag(html, "main") ??
    extractTag(html, "article") ??
    extractTag(html, "body") ??
    html;

  return service.turndown(extracted);
}

function extractTag(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = html.match(re);
  return m ? m[1]! : null;
}
