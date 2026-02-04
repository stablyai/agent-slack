import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_SLACK_DIR = join(homedir(), ".config", "agent-slack");
export const CREDENTIALS_FILE = join(AGENT_SLACK_DIR, "credentials.json");
export const KEYCHAIN_SERVICE = "agent-slack";
