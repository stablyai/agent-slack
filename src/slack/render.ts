import { slackMrkdwnToMarkdown } from "./mrkdwn.ts";

type UnknownRecord = Record<string, unknown>;
type RenderState = { depth: number; seen: WeakSet<object> };
const MAX_ATTACHMENT_DEPTH = 8;

export function renderSlackMessageContent(msg: unknown): string {
  const msgObj = isRecord(msg) ? msg : {};
  const blockMrkdwn = extractMrkdwnFromBlocks(msgObj.blocks);
  const attachmentMrkdwn = extractMrkdwnFromAttachments(msgObj.attachments, {
    depth: 0,
    seen: new WeakSet<object>(),
  });
  const combined = [blockMrkdwn.trim(), attachmentMrkdwn.trim()].filter(Boolean).join("\n\n");
  if (combined) {
    return slackMrkdwnToMarkdown(combined).trim();
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

function extractMrkdwnFromAttachments(attachments: unknown, state: RenderState): string {
  if (state.depth >= MAX_ATTACHMENT_DEPTH) {
    return "";
  }
  if (!Array.isArray(attachments)) {
    return "";
  }

  const parts: string[] = [];
  for (const a of attachments) {
    if (!isRecord(a)) {
      continue;
    }
    if (state.seen.has(a)) {
      continue;
    }
    state.seen.add(a);

    const isSharedMessage = Boolean(
      a.is_share || (a.is_msg_unfurl && Array.isArray(a.message_blocks)),
    );

    const chunk: string[] = [];

    if (isSharedMessage) {
      chunk.push(formatForwardHeader(a));

      const body =
        extractForwardedMessageBody(a, state).trim() ||
        extractMrkdwnFromAttachments(a.attachments, nextState(state)).trim() ||
        getString(a.text).trim();
      if (body) {
        chunk.push(quoteMarkdown(body));
      }

      if (chunk.length > 0) {
        parts.push(chunk.join("\n"));
      }
      continue;
    }

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
    const nestedAttachments = extractMrkdwnFromAttachments(a.attachments, nextState(state));
    if (nestedAttachments.trim()) {
      chunk.push(nestedAttachments);
    }
    if (chunk.length > 0) {
      parts.push(uniqueTexts(chunk).join("\n"));
    }
  }
  return uniqueTexts(parts).join("\n\n");
}

function formatForwardHeader(a: Record<string, unknown>): string {
  const authorName = getString(a.author_name);
  const authorLink = getString(a.author_link);
  const fromUrl = getString(a.from_url);

  const authorPart = authorName && authorLink ? `<${authorLink}|${authorName}>` : authorName || "";
  const sourcePart = fromUrl ? `<${fromUrl}|original>` : "";

  if (authorPart && sourcePart) {
    return `*Forwarded from ${authorPart} | ${sourcePart}*`;
  }
  if (authorPart) {
    return `*Forwarded from ${authorPart}*`;
  }
  if (sourcePart) {
    return `*Forwarded message | ${sourcePart}*`;
  }
  return "*Forwarded message*";
}

function extractForwardedMessageBody(
  attachment: Record<string, unknown>,
  state: RenderState,
): string {
  const messageBlocks = attachment.message_blocks;
  const topLevelFiles = extractFileMentions(attachment.files).trim();
  if (!Array.isArray(messageBlocks)) {
    return topLevelFiles;
  }
  const out: string[] = [];
  for (const mb of messageBlocks) {
    if (!isRecord(mb)) {
      continue;
    }
    const message = isRecord(mb.message) ? mb.message : null;
    if (!message) {
      continue;
    }
    const messageText = getString(message.text).trim();
    const blocksContent = extractMrkdwnFromBlocks(message.blocks).trim();
    const attachmentsContent = extractMrkdwnFromAttachments(
      message.attachments,
      nextState(state),
    ).trim();
    const fileMentions = extractFileMentions(message.files).trim();
    const content = uniqueTexts([
      blocksContent,
      attachmentsContent,
      messageText,
      fileMentions,
    ]).join("\n\n");
    if (content) {
      out.push(content);
    }
  }
  return uniqueTexts([topLevelFiles, ...out]).join("\n");
}

function nextState(state: RenderState): RenderState {
  return { depth: state.depth + 1, seen: state.seen };
}

function quoteMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function uniqueTexts(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = value.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    out.push(text);
  }
  return out;
}

function extractFileMentions(files: unknown): string {
  if (!Array.isArray(files)) {
    return "";
  }
  const lines: string[] = [];
  for (const f of files) {
    if (!isRecord(f)) {
      continue;
    }
    const name = getString(f.title) || getString(f.name) || "file";
    const url =
      getString(f.permalink) || getString(f.url_private_download) || getString(f.url_private);
    if (url) {
      lines.push(`<${url}|${name}>`);
      continue;
    }
    lines.push(name);
  }
  return uniqueTexts(lines).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
