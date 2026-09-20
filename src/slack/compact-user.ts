import { getString, isRecord } from "../lib/object-type-guards.ts";

export type CompactSlackUser = {
  id: string;
  name?: string; // handle
  real_name?: string;
  display_name?: string;
  email?: string;
  title?: string;
  tz?: string;
  is_bot?: boolean;
  deleted?: boolean;
  dm_id?: string;
  status_text?: string;
  status_emoji?: string;
  status_expiration?: number;
};

export function toCompactUser(u: Record<string, unknown>): CompactSlackUser {
  const profile = isRecord(u.profile) ? u.profile : {};
  return {
    id: getString(u.id) ?? "",
    name: getString(u.name) ?? undefined,
    real_name: getString(u.real_name) ?? getString(profile.real_name) ?? undefined,
    display_name: getString(profile.display_name) ?? undefined,
    email: getString(profile.email) ?? undefined,
    title: getString(profile.title) ?? undefined,
    tz: getString(u.tz) ?? undefined,
    is_bot: typeof u.is_bot === "boolean" ? u.is_bot : undefined,
    deleted: typeof u.deleted === "boolean" ? u.deleted : undefined,
    status_text: getString(profile.status_text) ?? undefined,
    status_emoji: getString(profile.status_emoji) ?? undefined,
    status_expiration:
      typeof profile.status_expiration === "number" ? profile.status_expiration : undefined,
  };
}
