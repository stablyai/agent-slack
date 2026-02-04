export function redactSecret(
  value: string,
  keepStart = 6,
  keepEnd = 4,
): string {
  if (!value) return value;
  if (value.length <= keepStart + keepEnd + 3) return "[redacted]";
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}
