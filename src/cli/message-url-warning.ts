export function warnOnTruncatedSlackUrl(ref: { possiblyTruncated?: boolean }): void {
  if (ref.possiblyTruncated) {
    console.error(
      'Hint: URL may have been truncated by shell. Quote URLs containing "&":\n' +
        '  agent-slack message get "https://...?thread_ts=...&cid=..."',
    );
  }
}
