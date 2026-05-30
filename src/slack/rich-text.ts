type InlineStyle = { bold?: true; italic?: true; strike?: true; code?: true };

type InlineElement =
  | { type: "text"; text: string; style?: InlineStyle }
  | { type: "link"; url: string; text?: string; style?: InlineStyle }
  | { type: "user"; user_id: string }
  | { type: "channel"; channel_id: string }
  | { type: "usergroup"; usergroup_id: string }
  | { type: "broadcast"; range: "here" | "channel" | "everyone" };

type RichTextElement =
  | { type: "rich_text_section"; elements: InlineElement[] }
  | {
      type: "rich_text_list";
      style: "bullet" | "ordered";
      indent?: number;
      elements: RichTextListItem[];
    }
  | { type: "rich_text_preformatted"; elements: InlineElement[] }
  | { type: "rich_text_quote"; elements: InlineElement[] };

type RichTextListItem = {
  type: "rich_text_section";
  elements: InlineElement[];
};

type RichTextBlock = {
  type: "rich_text";
  elements: RichTextElement[];
};

type TextToRichTextBlocksOptions = {
  includeInlineFormatting?: boolean;
};

const BULLET_RE = /^(\s*)[•◦▪▫▸‣●○◆◇\-*]\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
const CODE_BLOCK_START = /^```/;
const BLOCKQUOTE_RE = /^> (.*)$/;

/**
 * Parse mrkdwn inline formatting into Slack rich_text inline elements.
 *
 * Handles: *bold*, _italic_, ~strike~, `code`, <url|label>, <url>
 */
export function parseInlineElements(text: string): InlineElement[] {
  const elements: InlineElement[] = [];
  const re =
    /`([^`]+)`|\*([^*]+)\*|_([^_]+)_|~([^~]+)~|<@([UWB][A-Z0-9]+)(?:\|[^>]*)?>|<#([CG][A-Z0-9]+)(?:\|[^>]*)?>|<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>|<!(here|channel|everyone)(?:\|[^>]*)?>|<([^>|]+)\|([^>]+)>|<([^>|]+)>|(?:^|(?<=[^A-Za-z0-9_]))@([UWB][A-Z0-9]{6,})\b|(?:^|(?<=[^A-Za-z0-9_]))@(here|channel|everyone)\b/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const pushText = (slice: string): void => {
    if (slice) {
      elements.push({ type: "text", text: slice });
    }
  };

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      pushText(text.slice(lastIndex, match.index));
    }

    const [
      ,
      code,
      bold,
      italic,
      strike,
      userToken,
      channelToken,
      usergroupToken,
      broadcastToken,
      linkUrl,
      linkText,
      bareUrl,
      bareUserId,
      bareBroadcast,
    ] = match;
    if (code != null) {
      elements.push({ type: "text", text: code, style: { code: true } });
    } else if (bold != null) {
      elements.push({ type: "text", text: bold, style: { bold: true } });
    } else if (italic != null) {
      elements.push({ type: "text", text: italic, style: { italic: true } });
    } else if (strike != null) {
      elements.push({ type: "text", text: strike, style: { strike: true } });
    } else if (userToken != null) {
      elements.push({ type: "user", user_id: userToken });
    } else if (channelToken != null) {
      elements.push({ type: "channel", channel_id: channelToken });
    } else if (usergroupToken != null) {
      elements.push({ type: "usergroup", usergroup_id: usergroupToken });
    } else if (broadcastToken != null) {
      elements.push({
        type: "broadcast",
        range: broadcastToken as "here" | "channel" | "everyone",
      });
    } else if (linkUrl != null && linkText != null && isSlackManualLinkUrl(linkUrl)) {
      elements.push({ type: "link", url: linkUrl, text: linkText });
    } else if (linkUrl != null && linkText != null) {
      elements.push({ type: "text", text: `<${linkUrl}|${linkText}>` });
    } else if (bareUrl != null && isSlackManualLinkUrl(bareUrl)) {
      elements.push({ type: "link", url: bareUrl });
    } else if (bareUrl != null) {
      elements.push({ type: "text", text: `<${bareUrl}>` });
    } else if (bareUserId != null) {
      elements.push({ type: "user", user_id: bareUserId });
    } else if (bareBroadcast != null) {
      elements.push({
        type: "broadcast",
        range: bareBroadcast as "here" | "channel" | "everyone",
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    pushText(text.slice(lastIndex));
  }

  return elements.length > 0 ? elements : [{ type: "text", text }];
}

function isSlackManualLinkUrl(value: string): boolean {
  return /^(?:https?:\/\/|mailto:)/i.test(value);
}

/**
 * Convert mrkdwn text to Slack rich_text blocks when bullet or numbered
 * lists are detected. Returns `null` when the text contains no lists,
 * so the caller can fall back to plain `text`.
 */
export function textToRichTextBlocks(
  text: string,
  options: TextToRichTextBlocksOptions = {},
): RichTextBlock[] | null {
  const lines = text.split("\n");
  const elements: RichTextElement[] = [];
  let hasLists = false;
  let hasFormatting = false;
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx]!;

    // Code block
    if (CODE_BLOCK_START.test(line)) {
      idx++; // skip opening ```
      const codeLines: string[] = [];
      while (idx < lines.length && !CODE_BLOCK_START.test(lines[idx]!)) {
        codeLines.push(lines[idx]!);
        idx++;
      }
      if (idx < lines.length) {
        idx++;
      } // skip closing ```
      elements.push({
        type: "rich_text_preformatted",
        elements: [{ type: "text", text: codeLines.join("\n") }],
      });
      hasFormatting = true;
      continue;
    }

    // Blockquote
    const quoteMatch = line.match(BLOCKQUOTE_RE);
    if (quoteMatch) {
      const quoteLines: string[] = [];
      while (idx < lines.length) {
        const qm = lines[idx]!.match(BLOCKQUOTE_RE);
        if (!qm) {
          break;
        }
        quoteLines.push(qm[1]!);
        idx++;
      }
      elements.push({
        type: "rich_text_quote",
        elements: parseInlineElements(quoteLines.join("\n")),
      });
      hasFormatting = true;
      continue;
    }

    // Bullet list
    if (BULLET_RE.test(line)) {
      hasLists = true;
      idx = collectList({ lines, startIdx: idx, style: "bullet", pattern: BULLET_RE, elements });
      continue;
    }

    // Ordered list
    if (ORDERED_RE.test(line)) {
      hasLists = true;
      idx = collectList({ lines, startIdx: idx, style: "ordered", pattern: ORDERED_RE, elements });
      continue;
    }

    // Plain text — collect consecutive non-special lines
    const textLines: string[] = [];
    while (idx < lines.length) {
      const l = lines[idx]!;
      if (
        BULLET_RE.test(l) ||
        ORDERED_RE.test(l) ||
        CODE_BLOCK_START.test(l) ||
        BLOCKQUOTE_RE.test(l)
      ) {
        break;
      }
      textLines.push(l);
      idx++;
    }
    const content = textLines.join("\n");
    if (content.trim()) {
      const inlineElements = parseInlineElements(content.endsWith("\n") ? content : `${content}\n`);
      if (hasRichInlineFormatting(inlineElements)) {
        hasFormatting = true;
      }
      elements.push({
        type: "rich_text_section",
        elements: inlineElements,
      });
    }
  }

  if (!hasLists && !(options.includeInlineFormatting && hasFormatting)) {
    return null;
  }

  return [{ type: "rich_text", elements }];
}

function hasRichInlineFormatting(elements: InlineElement[]): boolean {
  return elements.some((element) => element.type !== "text" || Boolean(element.style));
}

function collectList(input: {
  lines: string[];
  startIdx: number;
  style: "bullet" | "ordered";
  pattern: RegExp;
  elements: RichTextElement[];
}): number {
  const { lines, startIdx, style, pattern, elements } = input;
  let idx = startIdx;

  // Determine base indent from the first bullet in this group
  const firstMatch = lines[startIdx]!.match(pattern)!;
  const baseIndent = firstMatch[1]!.length;

  let currentIndent = -1;
  let currentItems: RichTextListItem[] = [];

  while (idx < lines.length) {
    const match = lines[idx]!.match(pattern);
    if (!match) {
      break;
    }

    // Anything significantly deeper (>= baseIndent + 2) is a sub-bullet
    const indent = match[1]!.length >= baseIndent + 2 ? 1 : 0;
    const content = match[2]!;

    if (currentIndent !== -1 && indent !== currentIndent) {
      elements.push({
        type: "rich_text_list",
        style,
        ...(currentIndent > 0 ? { indent: currentIndent } : {}),
        elements: currentItems,
      });
      currentItems = [];
    }

    currentIndent = indent;
    currentItems.push({
      type: "rich_text_section",
      elements: parseInlineElements(content),
    });
    idx++;
  }

  if (currentItems.length > 0) {
    elements.push({
      type: "rich_text_list",
      style,
      ...(currentIndent > 0 ? { indent: currentIndent } : {}),
      elements: currentItems,
    });
  }

  return idx;
}
