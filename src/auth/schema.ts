import { z } from "zod";
import {
  normalizeSlackWorkspaceUrl,
  SLACK_WORKSPACE_ORIGIN_ERROR,
} from "../slack/workspace-url.ts";

const SlackWorkspaceUrlSchema = z
  .string()
  .refine(
    (value) => {
      try {
        normalizeSlackWorkspaceUrl(value);
        return true;
      } catch {
        return false;
      }
    },
    {
      error: SLACK_WORKSPACE_ORIGIN_ERROR,
    },
  )
  .transform((value) => normalizeSlackWorkspaceUrl(value));

export const WorkspaceAuthSchema = z.union([
  z.object({
    auth_type: z.literal("standard"),
    token: z.string().min(1),
  }),
  z.object({
    auth_type: z.literal("browser"),
    xoxc_token: z.string().min(1),
    xoxd_cookie: z.string().min(1),
  }),
]);

export type WorkspaceAuth = z.infer<typeof WorkspaceAuthSchema>;

export const WorkspaceSchema = z.object({
  workspace_url: SlackWorkspaceUrlSchema,
  workspace_name: z.string().optional(),
  team_id: z.string().optional(),
  team_domain: z.string().optional(),
  auth: WorkspaceAuthSchema,
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

export const CredentialsSchema = z.object({
  version: z.literal(1),
  updated_at: z.string().optional(),
  default_workspace_url: SlackWorkspaceUrlSchema.optional(),
  workspaces: z.array(WorkspaceSchema).default([]),
});

export type Credentials = z.infer<typeof CredentialsSchema>;
