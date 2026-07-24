export type Page = Record<string, unknown> | Error;

export function activeUser(
  id: string,
  options: {
    name?: string;
    realName?: string;
    displayName?: string;
    email?: string;
    deleted?: boolean;
    isBot?: boolean;
    extra?: Record<string, unknown>;
    profileExtra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const realName = options.realName ?? options.name;
  return {
    id,
    name: options.name,
    real_name: realName,
    deleted: options.deleted ?? false,
    is_bot: options.isBot ?? false,
    profile: {
      real_name: realName,
      display_name: options.displayName,
      email: options.email,
      ...options.profileExtra,
    },
    ...options.extra,
  };
}

export function createClient(pages: Page[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let index = 0;
  const client = {
    api: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      const page = pages[index++];
      if (!page) {
        throw new Error(`Unexpected API call ${index}`);
      }
      if (page instanceof Error) {
        throw page;
      }
      return page;
    },
  };
  return { client: client as never, calls };
}
