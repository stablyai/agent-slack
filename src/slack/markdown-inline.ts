type ParsedCodeSpan = {
  content: string;
  end: number;
};

type ParsedMarkdownLink = {
  label: string;
  url: string;
  end: number;
};

type CodeDelimiter = {
  openerEnd: number;
  closerStart: number;
  end: number;
};

type DelimiterIndex = {
  codeDelimiters: Map<number, CodeDelimiter>;
  squareBracketEnds: Map<number, number>;
  parenthesisEnds: Map<number, number>;
  angleBracketEnds: Map<number, number>;
  escaped: Uint8Array;
};

type ParserContext = {
  text: string;
  index: DelimiterIndex;
};

export type MarkdownInlineParser = {
  codeSpanAt: (start: number) => ParsedCodeSpan | null;
  markdownLinkAt: (start: number) => ParsedMarkdownLink | null;
};

export type ProtectedMarkdownInlineToken =
  | { type: "code"; content: string; raw: string }
  | { type: "link"; label: string; url: string; raw: string };

export type ProtectedMarkdownInline = {
  text: string;
  tokens: ProtectedMarkdownInlineToken[];
  marker: string;
  suffix: string;
};

export function createMarkdownInlineParser(text: string): MarkdownInlineParser {
  const context = { text, index: buildDelimiterIndex(text) };
  return {
    codeSpanAt: (start) => parseCodeSpanAt(context, start),
    markdownLinkAt: (start) => parseMarkdownLinkAt(context, start),
  };
}

export function protectMarkdownInline(text: string): ProtectedMarkdownInline {
  const parser = createMarkdownInlineParser(text);
  let marker = "\uE000";
  while (text.includes(marker)) {
    marker += "\uE000";
  }
  const suffix = "\uE001";
  const tokens: ProtectedMarkdownInlineToken[] = [];
  let protectedText = "";
  let cursor = 0;

  while (cursor < text.length) {
    const codeSpan = parser.codeSpanAt(cursor);
    if (codeSpan) {
      tokens.push({
        type: "code",
        content: codeSpan.content,
        raw: text.slice(cursor, codeSpan.end),
      });
      protectedText += `${marker}${tokens.length - 1}${suffix}`;
      cursor = codeSpan.end;
      continue;
    }

    const link = parser.markdownLinkAt(cursor);
    if (link) {
      tokens.push({
        type: "link",
        label: link.label,
        url: link.url,
        raw: text.slice(cursor, link.end),
      });
      protectedText += `${marker}${tokens.length - 1}${suffix}`;
      cursor = link.end;
      continue;
    }

    protectedText += text[cursor];
    cursor++;
  }

  return { text: protectedText, tokens, marker, suffix };
}

export function restoreProtectedMarkdownLiterals(
  text: string,
  context: ProtectedMarkdownInline,
): string {
  const { marker, suffix, tokens } = context;
  const tokenPattern = new RegExp(`${escapeRegExp(marker)}(\\d+)${escapeRegExp(suffix)}`, "g");
  return text.replace(tokenPattern, (match, tokenIndex) => {
    return tokens[Number(tokenIndex)]?.raw ?? match;
  });
}

export function markdownLinksToSlackMrkdwn(text: string): string {
  const parser = createMarkdownInlineParser(text);
  let output = "";
  let cursor = 0;

  while (cursor < text.length) {
    const codeSpan = parser.codeSpanAt(cursor);
    if (codeSpan) {
      output += text.slice(cursor, codeSpan.end);
      cursor = codeSpan.end;
      continue;
    }

    const link = parser.markdownLinkAt(cursor);
    if (link) {
      const label = link.label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const url = link.url.replace(/\|/g, "%7C").replace(/</g, "%3C").replace(/>/g, "%3E");
      output += `<${url}|${label}>`;
      cursor = link.end;
      continue;
    }

    output += text[cursor];
    cursor++;
  }

  return output;
}

function parseCodeSpanAt(context: ParserContext, start: number): ParsedCodeSpan | null {
  const { text, index } = context;
  const delimiter = index.codeDelimiters.get(start);
  if (!delimiter) {
    return null;
  }
  return {
    content: text.slice(delimiter.openerEnd, delimiter.closerStart),
    end: delimiter.end,
  };
}

function parseMarkdownLinkAt(context: ParserContext, start: number): ParsedMarkdownLink | null {
  const { text, index } = context;
  if (
    text[start] !== "[" ||
    index.escaped[start] === 1 ||
    (text[start - 1] === "!" && index.escaped[start - 1] !== 1)
  ) {
    return null;
  }

  const labelEnd = index.squareBracketEnds.get(start);
  if (labelEnd == null || text[labelEnd + 1] !== "(") {
    return null;
  }

  const destination = parseLinkDestination(context, labelEnd + 1);
  if (!destination) {
    return null;
  }

  const rawUrl = unescapeMarkdownPunctuation(destination.value);
  const scheme = /^(https?|mailto):/i.exec(rawUrl)!;
  return {
    label: unescapeMarkdownPunctuation(text.slice(start + 1, labelEnd)),
    url: `${scheme[1]!.toLowerCase()}:${rawUrl.slice(scheme[0].length)}`,
    end: destination.end,
  };
}

function parseLinkDestination(
  context: ParserContext,
  openingParenthesis: number,
): { value: string; end: number } | null {
  const { text, index } = context;
  const start = openingParenthesis + 1;
  let valueStart = start;
  let valueEnd: number | undefined;
  let end: number;

  if (text[start] === "<") {
    valueStart++;
    valueEnd = index.angleBracketEnds.get(start);
    if (valueEnd == null || text[valueEnd + 1] !== ")") {
      return null;
    }
    end = valueEnd + 2;
  } else {
    valueEnd = index.parenthesisEnds.get(openingParenthesis);
    if (valueEnd == null || valueEnd === start) {
      return null;
    }
    end = valueEnd + 1;
  }

  const value = text.slice(valueStart, valueEnd);
  if (!isSupportedLinkDestination(unescapeMarkdownPunctuation(value))) {
    return null;
  }
  return { value, end };
}

function isSupportedLinkDestination(value: string): boolean {
  return /^(?:https?:\/\/.+|mailto:.+)/i.test(value);
}

function buildDelimiterIndex(text: string): DelimiterIndex {
  const squareBracketEnds = new Map<number, number>();
  const parenthesisEnds = new Map<number, number>();
  const angleBracketEnds = new Map<number, number>();
  const escaped = new Uint8Array(text.length);
  const squareStack: number[] = [];
  const parenthesisStack: number[] = [];
  let openAngleBracket: number | undefined;
  let precedingBackslashes = 0;

  for (let cursor = 0; cursor < text.length; cursor++) {
    const char = text[cursor]!;
    if (char === "\\") {
      precedingBackslashes++;
      continue;
    }

    const isEscaped = precedingBackslashes % 2 === 1;
    precedingBackslashes = 0;
    if (isEscaped) {
      escaped[cursor] = 1;
    }

    if (char === "\n") {
      squareStack.length = 0;
      parenthesisStack.length = 0;
      openAngleBracket = undefined;
      continue;
    }
    if (/\s/.test(char)) {
      parenthesisStack.length = 0;
      openAngleBracket = undefined;
    }
    if (isEscaped) {
      continue;
    }

    if (char === "[") {
      squareStack.push(cursor);
    } else if (char === "]") {
      const start = squareStack.pop();
      if (start != null) {
        squareBracketEnds.set(start, cursor);
      }
    }

    if (char === "(") {
      parenthesisStack.push(cursor);
    } else if (char === ")") {
      const start = parenthesisStack.pop();
      if (start != null) {
        parenthesisEnds.set(start, cursor);
      }
    }

    if (char === "<") {
      openAngleBracket = cursor;
    } else if (char === ">" && openAngleBracket != null) {
      angleBracketEnds.set(openAngleBracket, cursor);
      openAngleBracket = undefined;
    }
  }

  return {
    codeDelimiters: buildCodeDelimiterIndex(text, escaped),
    squareBracketEnds,
    parenthesisEnds,
    angleBracketEnds,
    escaped,
  };
}

function buildCodeDelimiterIndex(text: string, escaped: Uint8Array): Map<number, CodeDelimiter> {
  const runs: { start: number; end: number }[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor++;
      continue;
    }

    const rawStart = cursor;
    while (text[cursor] === "`") {
      cursor++;
    }
    runs.push({ start: rawStart, end: cursor });
  }

  const codeDelimiters = new Map<number, CodeDelimiter>();
  const nextRunByLength = new Map<number, { start: number; end: number }>();
  for (let idx = runs.length - 1; idx >= 0; idx--) {
    const run = runs[idx]!;
    // Outside a code span, a backslash escapes the first backtick in a run,
    // so only the remainder can open a span. Inside a span, backslashes are
    // literal: the complete raw run remains eligible to close an earlier
    // opener.
    const openerStart = escaped[run.start] === 1 ? run.start + 1 : run.start;
    const openerLength = run.end - openerStart;
    const closer = nextRunByLength.get(openerLength);
    if (openerLength > 0 && closer) {
      codeDelimiters.set(openerStart, {
        openerEnd: run.end,
        closerStart: closer.start,
        end: closer.end,
      });
    }
    nextRunByLength.set(run.end - run.start, run);
  }

  return codeDelimiters;
}

function unescapeMarkdownPunctuation(value: string): string {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const next = value[cursor + 1];
    if (value[cursor] === "\\" && next && isAsciiPunctuation(next)) {
      output += next;
      cursor += 2;
      continue;
    }
    output += value[cursor];
    cursor++;
  }

  return output;
}

function isAsciiPunctuation(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
