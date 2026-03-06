/**
 * Rich-text block rendering helpers extracted from render.ts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function extractMrkdwnFromRichTextBlock(block: unknown): string {
  if (!isRecord(block)) {
    return "";
  }
  const elements = Array.isArray(block.elements) ? block.elements : [];
  const out: string[] = [];
  for (const el of elements) {
    const txt = extractMrkdwnFromRichTextElement(el);
    if (txt.trim()) {
      out.push(txt);
    }
  }
  return out.join("\n\n");
}

function extractMrkdwnFromRichTextElement(el: unknown): string {
  if (!isRecord(el)) {
    return "";
  }
  const t = getString(el.type);

  if (t === "rich_text_section") {
    const parts: string[] = [];
    for (const child of Array.isArray(el.elements) ? el.elements : []) {
      parts.push(extractMrkdwnFromRichTextElement(child));
    }
    return parts.join("");
  }

  if (t === "rich_text_preformatted") {
    const parts: string[] = [];
    for (const child of Array.isArray(el.elements) ? el.elements : []) {
      parts.push(extractMrkdwnFromRichTextElement(child));
    }
    const text = parts.join("");
    return text ? `\`\`\`${text}\`\`\`` : "";
  }

  if (t === "rich_text_quote") {
    const parts: string[] = [];
    for (const child of Array.isArray(el.elements) ? el.elements : []) {
      parts.push(extractMrkdwnFromRichTextElement(child));
    }
    const text = parts.join("").trim();
    if (!text) {
      return "";
    }
    return text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  if (t === "rich_text_list") {
    const style = typeof el.style === "string" ? el.style : "bullet";
    const items: string[] = [];
    const itemEls = Array.isArray(el.elements) ? el.elements : [];
    let num = 0;
    for (const item of itemEls) {
      const txt = extractMrkdwnFromRichTextElement(item).trim();
      if (!txt) {
        continue;
      }
      num++;
      const prefix = style === "ordered" ? `${num}. ` : "- ";
      items.push(`${prefix}${txt}`);
    }
    return items.join("\n");
  }

  if (t === "text") {
    const raw = getString(el.text);
    const style = isRecord(el.style) ? el.style : null;
    if (!style) {
      return raw;
    }
    let text = raw;
    if (style.code) {
      text = `\`${text}\``;
    }
    if (style.bold) {
      text = `*${text}*`;
    }
    if (style.italic) {
      text = `_${text}_`;
    }
    if (style.strike) {
      text = `~${text}~`;
    }
    return text;
  }

  if (t === "link") {
    const url = getString(el.url);
    const text = getString(el.text);
    if (!url) {
      return text;
    }
    return text ? `<${url}|${text}>` : url;
  }

  if (t === "emoji") {
    const name = getString(el.name);
    return name ? `:${name}:` : "";
  }

  if (t === "user") {
    const userId = getString(el.user_id);
    return userId ? `<@${userId}>` : "";
  }

  if (t === "channel") {
    const channelId = getString(el.channel_id);
    return channelId ? `<#${channelId}>` : "";
  }

  return "";
}
