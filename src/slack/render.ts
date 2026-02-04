import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";

type UnknownRecord = Record<string, unknown>;

export function renderSlackMessageContent(msg: unknown): string {
  const msgObj = isRecord(msg) ? msg : {};
  const blockMrkdwn = extractMrkdwnFromBlocks(msgObj.blocks);
  if (blockMrkdwn.trim()) {
    return slackMrkdwnToMarkdown(blockMrkdwn).trim();
  }

  const attachmentMrkdwn = extractMrkdwnFromAttachments(msgObj.attachments);
  if (attachmentMrkdwn.trim()) {
    return slackMrkdwnToMarkdown(attachmentMrkdwn).trim();
  }

  const text = getString(msgObj.text).trim();
  if (text) {
    return slackMrkdwnToMarkdown(text).trim();
  }

  return "";
}

function extractMrkdwnFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) {
    return "";
  }

  const out: string[] = [];
  for (const b of blocks) {
    if (!isRecord(b)) {
      continue;
    }
    const type = getString(b.type);
    if (type === "section") {
      const text = isRecord(b.text) ? b.text : null;
      const textType = text ? getString(text.type) : "";
      if (textType === "mrkdwn" || textType === "plain_text") {
        out.push(getString(text?.text));
      }
      if (Array.isArray(b.fields)) {
        for (const f of b.fields) {
          if (!isRecord(f)) {
            continue;
          }
          const fieldType = getString(f.type);
          if (fieldType === "mrkdwn" || fieldType === "plain_text") {
            out.push(getString(f.text));
          }
        }
      }
      // Buttons often carry the only URL (e.g. "View Progress")
      const accessory = isRecord(b.accessory) ? b.accessory : null;
      if (getString(accessory?.type) === "button") {
        const label = getString((accessory?.text as UnknownRecord | undefined)?.text);
        const url = getString(accessory?.url);
        if (url) {
          out.push(label ? `${label}: ${url}` : url);
        }
      }
      continue;
    }
    if (type === "actions" && Array.isArray(b.elements)) {
      for (const el of b.elements) {
        if (!isRecord(el)) {
          continue;
        }
        if (getString(el.type) === "button") {
          const label = getString((el.text as UnknownRecord | undefined)?.text);
          const url = getString(el.url);
          if (url) {
            out.push(label ? `${label}: ${url}` : url);
          }
        }
      }
      continue;
    }
    if (type === "context" && Array.isArray(b.elements)) {
      for (const el of b.elements) {
        if (!isRecord(el)) {
          continue;
        }
        const elType = getString(el.type);
        if (elType === "mrkdwn") {
          out.push(getString(el.text));
        }
        if (elType === "plain_text") {
          out.push(getString(el.text));
        }
      }
      continue;
    }
    if (type === "image") {
      const alt = getString(b.alt_text);
      const url = getString(b.image_url);
      if (url) {
        out.push(alt ? `${alt}: ${url}` : url);
      }
      continue;
    }
    if (type === "rich_text") {
      const rich = extractMrkdwnFromRichTextBlock(b);
      if (rich.trim()) {
        out.push(rich);
      }
      continue;
    }
  }

  return out.join("\n\n");
}

function extractMrkdwnFromRichTextBlock(block: unknown): string {
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
    for (let idx = 0; idx < itemEls.length; idx++) {
      const item = itemEls[idx];
      const txt = extractMrkdwnFromRichTextElement(item).trim();
      if (!txt) {
        continue;
      }
      const prefix = style === "ordered" ? `${idx + 1}. ` : "- ";
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

function extractMrkdwnFromAttachments(attachments: unknown): string {
  if (!Array.isArray(attachments)) {
    return "";
  }

  const parts: string[] = [];
  for (const a of attachments) {
    if (!isRecord(a)) {
      continue;
    }
    const chunk: string[] = [];
    const blocks = extractMrkdwnFromBlocks(a.blocks);
    if (blocks.trim()) {
      chunk.push(blocks);
    }
    const pretext = getString(a.pretext);
    if (pretext) {
      chunk.push(pretext);
    }
    const title = getString(a.title);
    const titleLink = getString(a.title_link);
    if (titleLink && title) {
      chunk.push(`<${titleLink}|${title}>`);
    } else if (title) {
      chunk.push(title);
    } else if (titleLink) {
      chunk.push(titleLink);
    }
    const text = getString(a.text);
    if (text) {
      chunk.push(text);
    }
    if (Array.isArray(a.fields)) {
      for (const f of a.fields) {
        if (!isRecord(f)) {
          continue;
        }
        const fieldTitle = getString(f.title);
        const value = getString(f.value);
        if (fieldTitle && value) {
          chunk.push(`${fieldTitle}\n${value}`);
        } else if (fieldTitle) {
          chunk.push(fieldTitle);
        } else if (value) {
          chunk.push(value);
        }
      }
    }
    const fallback = getString(a.fallback);
    if (chunk.length === 0 && fallback) {
      chunk.push(fallback);
    }
    if (chunk.length > 0) {
      parts.push(chunk.join("\n"));
    }
  }
  return parts.join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
