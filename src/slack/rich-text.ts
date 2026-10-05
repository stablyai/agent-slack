type InlineStyle = { bold?: true; italic?: true; strike?: true; code?: true };

type InlineElement =
  | { type: "text"; text: string; style?: InlineStyle }
  | { type: "link"; url: string; text?: string; style?: InlineStyle }
  | { type: "emoji"; name: string }
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
      offset?: number;
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
 * Handles: *bold*, _italic_, ~strike~, `code`, :emoji:, <url|label>, <url>
 */
export function parseInlineElements(text: string): InlineElement[] {
  const elements: InlineElement[] = [];
  const re =
    /`([^`]+)`|(?:^|(?<=[^A-Za-z0-9_])):([a-zA-Z0-9_+-]+):(?![A-Za-z0-9_+-])|\*([^*]+)\*|_([^_]+)_|~([^~]+)~|<@([UWB][A-Z0-9]+)(?:\|[^>]*)?>|<#([CG][A-Z0-9]+)(?:\|[^>]*)?>|<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>|<!(here|channel|everyone)(?:\|[^>]*)?>|<([^>|]+)\|([^>]+)>|<([^>|]+)>|(?:^|(?<=[^A-Za-z0-9_]))@([UWB][A-Z0-9]{6,})\b|(?:^|(?<=[^A-Za-z0-9_]))@(here|channel|everyone)\b/g;
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
      emojiName,
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
    } else if (emojiName != null) {
      elements.push({ type: "emoji", name: emojiName });
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
  const orderedCounts = new Map<number, number>();

  while (idx < lines.length) {
    const line = lines[idx]!;

    // Code block
    if (CODE_BLOCK_START.test(line)) {
      orderedCounts.clear();
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
      orderedCounts.clear();
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

    // List
    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      hasLists = true;
      idx = collectList({ lines, startIdx: idx, elements, orderedCounts });
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
      // Blank lines between items keep a loose list going. Real text ends it.
      orderedCounts.clear();
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
  elements: RichTextElement[];
  orderedCounts: Map<number, number>;
}): number {
  const { lines, startIdx, elements, orderedCounts } = input;
  let idx = startIdx;
  const firstMatch = lines[startIdx]!.match(BULLET_RE) ?? lines[startIdx]!.match(ORDERED_RE)!;
  const baseIndent = firstMatch[1]!.length;
  let currentStyle: "bullet" | "ordered" | null = null;
  let currentIndent = -1;
  let currentItems: RichTextListItem[] = [];
  // The number the author wrote on the first item of the current ordered group.
  let currentStart = 1;
  // True until the first group of this run is flushed. A run starts after a
  // blank line, so a "1." there is a deliberate restart.
  let firstGroup = true;

  const flush = (): void => {
    if (currentStyle == null || currentItems.length === 0) {
      return;
    }

    // Prefer the number the author wrote. A "1." only continues the count when
    // it follows a nested list in the same run, as in lazily numbered Markdown.
    let offset = 0;
    if (currentStyle === "ordered") {
      if (currentStart > 1) {
        offset = currentStart - 1;
      } else if (!firstGroup) {
        offset = orderedCounts.get(currentIndent) ?? 0;
      }
    }

    const list: RichTextElement = {
      type: "rich_text_list",
      style: currentStyle,
      ...(currentIndent > 0 ? { indent: currentIndent } : {}),
      ...(offset > 0 ? { offset } : {}),
      elements: currentItems,
    };
    elements.push(list);
    // Items at this level end any deeper list, so nested numbering restarts.
    for (const level of orderedCounts.keys()) {
      if (level > currentIndent) {
        orderedCounts.delete(level);
      }
    }
    if (currentStyle === "ordered") {
      orderedCounts.set(currentIndent, offset + currentItems.length);
    } else {
      // A bullet list at the same level ends the ordered list there.
      orderedCounts.delete(currentIndent);
    }
    currentItems = [];
    firstGroup = false;
  };

  while (idx < lines.length) {
    const line = lines[idx]!;
    const bulletMatch = line.match(BULLET_RE);
    const orderedMatch = line.match(ORDERED_RE);
    if (bulletMatch == null && orderedMatch == null) {
      break;
    }

    const style = orderedMatch != null ? "ordered" : "bullet";
    const match = orderedMatch ?? bulletMatch!;
    const indent = match[1]!.length >= baseIndent + 2 ? 1 : 0;
    if (currentStyle !== style || currentIndent !== indent) {
      flush();
      currentStyle = style;
      currentIndent = indent;
      currentStart = orderedMatch != null ? Number.parseInt(line.trim(), 10) : 1;
    }
    currentItems.push({
      type: "rich_text_section",
      elements: parseInlineElements(match[2]!),
    });
    idx++;
  }

  flush();
  return idx;
}
