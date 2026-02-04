declare module "turndown-plugin-gfm" {
  // The upstream package has no TS types; keep this minimal.
  import type TurndownService from "turndown";

  export const gfm: TurndownService.Plugin;
  export const gfmExtended: TurndownService.Plugin;
}
