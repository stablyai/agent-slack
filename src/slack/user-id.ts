const USER_ID_PATTERN = /^[UW][A-Z0-9]{8,}$/;

/**
 * Slack uses both U-prefixed and W-prefixed IDs for users. Treat them as
 * equivalent while preserving the CLI's existing length and character rules.
 */
export function isUserId(input: string): boolean {
  return USER_ID_PATTERN.test(input);
}
