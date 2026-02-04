export function redactSecret(
  value: string,
  options?: { keepStart?: number; keepEnd?: number },
): string {
  const keepStart = options?.keepStart ?? 6;
  const keepEnd = options?.keepEnd ?? 4;
  if (!value) {
    return value;
  }
  if (value.length <= keepStart + keepEnd + 3) {
    return "[redacted]";
  }
  return `${value.slice(0, keepStart)}…${value.slice(-keepEnd)}`;
}
