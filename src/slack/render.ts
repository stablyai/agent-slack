import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";

export function renderSlackMessageContent(msg: any): string {
  const blockMrkdwn = extractMrkdwnFromBlocks(msg?.blocks);
  if (blockMrkdwn.trim()) {
    return slackMrkdwnToMarkdown(blockMrkdwn).trim();
  }

  const attachmentMrkdwn = extractMrkdwnFromAttachments(msg?.attachments);
  if (attachmentMrkdwn.trim()) {
    return slackMrkdwnToMarkdown(attachmentMrkdwn).trim();
  }

  const text = String(msg?.text ?? "").trim();
  if (text) {
    return slackMrkdwnToMarkdown(text).trim();
  }

  return "";
}

function extractMrkdwnFromBlocks(blocks: any): string {
  if (!Array.isArray(blocks)) return "";

  const out: string[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "section") {
      if (b.text?.type === "mrkdwn" || b.text?.type === "plain_text") {
        out.push(String(b.text.text ?? ""));
      }
      if (Array.isArray(b.fields)) {
        for (const f of b.fields) {
          if (!f || typeof f !== "object") continue;
          if (f.type === "mrkdwn" || f.type === "plain_text") {
            out.push(String(f.text ?? ""));
          }
        }
      }
      // Buttons often carry the only URL (e.g. "View Progress")
      if (b.accessory?.type === "button") {
        const label = b.accessory.text?.text
          ? String(b.accessory.text.text)
          : "";
        const url = b.accessory.url ? String(b.accessory.url) : "";
        if (url) out.push(label ? `${label}: ${url}` : url);
      }
      continue;
    }
    if (b.type === "actions" && Array.isArray(b.elements)) {
      for (const el of b.elements) {
        if (!el || typeof el !== "object") continue;
        if (el.type === "button") {
          const label = el.text?.text ? String(el.text.text) : "";
          const url = el.url ? String(el.url) : "";
          if (url) out.push(label ? `${label}: ${url}` : url);
        }
      }
      continue;
    }
    if (b.type === "context" && Array.isArray(b.elements)) {
      for (const el of b.elements) {
        if (el?.type === "mrkdwn") out.push(String(el.text ?? ""));
        if (el?.type === "plain_text") out.push(String(el.text ?? ""));
      }
      continue;
    }
    if (b.type === "image") {
      const alt = b.alt_text ? String(b.alt_text) : "";
      const url = b.image_url ? String(b.image_url) : "";
      if (url) out.push(alt ? `${alt}: ${url}` : url);
      continue;
    }
    if (b.type === "rich_text") {
      const rich = extractMrkdwnFromRichTextBlock(b);
      if (rich.trim()) out.push(rich);
      continue;
    }
  }

  return out.join("\n\n");
}

function extractMrkdwnFromRichTextBlock(block: any): string {
  const elements = Array.isArray(block?.elements) ? block.elements : [];
  const out: string[] = [];
  for (const el of elements) {
    const txt = extractMrkdwnFromRichTextElement(el);
    if (txt.trim()) out.push(txt);
  }
  return out.join("\n\n");
}

function extractMrkdwnFromRichTextElement(el: any): string {
  if (!el || typeof el !== "object") return "";
  const t = String(el.type ?? "");

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
    return text ? "```" + text + "```" : "";
  }

  if (t === "rich_text_quote") {
    const parts: string[] = [];
    for (const child of Array.isArray(el.elements) ? el.elements : []) {
      parts.push(extractMrkdwnFromRichTextElement(child));
    }
    const text = parts.join("").trim();
    if (!text) return "";
    return text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  if (t === "rich_text_list") {
    const style = String(el.style ?? "bullet");
    const items: string[] = [];
    const itemEls = Array.isArray(el.elements) ? el.elements : [];
    for (let idx = 0; idx < itemEls.length; idx++) {
      const item = itemEls[idx];
      const txt = extractMrkdwnFromRichTextElement(item).trim();
      if (!txt) continue;
      const prefix = style === "ordered" ? `${idx + 1}. ` : "- ";
      items.push(prefix + txt);
    }
    return items.join("\n");
  }

  if (t === "text") {
    const raw = String(el.text ?? "");
    const style = el.style && typeof el.style === "object" ? el.style : null;
    if (!style) return raw;
    let text = raw;
    if (style.code) text = "`" + text + "`";
    if (style.bold) text = "*" + text + "*";
    if (style.italic) text = "_" + text + "_";
    if (style.strike) text = "~" + text + "~";
    return text;
  }

  if (t === "link") {
    const url = String(el.url ?? "");
    const text = String(el.text ?? "");
    if (!url) return text;
    return text ? `<${url}|${text}>` : url;
  }

  if (t === "emoji") {
    const name = String(el.name ?? "");
    return name ? `:${name}:` : "";
  }

  if (t === "user") {
    const userId = String(el.user_id ?? "");
    return userId ? `<@${userId}>` : "";
  }

  if (t === "channel") {
    const channelId = String(el.channel_id ?? "");
    return channelId ? `<#${channelId}>` : "";
  }

  return "";
}

function extractMrkdwnFromAttachments(attachments: any): string {
  if (!Array.isArray(attachments)) return "";

  const parts: string[] = [];
  for (const a of attachments) {
    if (!a || typeof a !== "object") continue;
    const chunk: string[] = [];
    const blocks = extractMrkdwnFromBlocks(a.blocks);
    if (blocks.trim()) chunk.push(blocks);
    if (a.pretext) chunk.push(String(a.pretext));
    if (a.title_link && a.title) {
      chunk.push(`<${String(a.title_link)}|${String(a.title)}>`);
    } else if (a.title) {
      chunk.push(String(a.title));
    } else if (a.title_link) {
      chunk.push(String(a.title_link));
    }
    if (a.text) chunk.push(String(a.text));
    if (Array.isArray(a.fields)) {
      for (const f of a.fields) {
        if (!f || typeof f !== "object") continue;
        const title = f.title ? String(f.title) : "";
        const value = f.value ? String(f.value) : "";
        if (title && value) chunk.push(`${title}\n${value}`);
        else if (title) chunk.push(title);
        else if (value) chunk.push(value);
      }
    }
    if (chunk.length === 0 && a.fallback) chunk.push(String(a.fallback));
    if (chunk.length > 0) parts.push(chunk.join("\n"));
  }
  return parts.join("\n\n");
}
