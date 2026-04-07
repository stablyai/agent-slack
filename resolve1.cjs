const fs = require("fs");

let content = fs.readFileSync("skills/agent-slack/references/commands.md", "utf-8");

const regex =
  /<<<<<<< HEAD[\s\S]*?=======\n(## Unreads[\s\S]*?)>>>>>>> e123d29 \(feat: add unreads command for inbox-style unread message view\)/;

const newString = `## Later

- \`agent-slack later list\` â€” list saved-for-later messages (default: in-progress)
  - Options:
    - \`--workspace <url-or-unique-substring>\` (defaults to configured workspace)
    - \`--state <state>\` (filter: \`in_progress\` (default), \`archived\`, \`completed\`, \`all\`)
    - \`--limit <n>\` (max items, default \`20\`)
    - \`--max-body-chars <n>\` (max content chars per message, default \`4000\`, \`-1\` unlimited)
    - \`--counts-only\` (only show counts per state)

- \`agent-slack later complete <target>\` â€” mark a saved message as completed
- \`agent-slack later archive <target>\` â€” archive a saved message
- \`agent-slack later reopen <target>\` â€” move back to in-progress (from completed or archived)
- \`agent-slack later save <target>\` â€” save a message for later
- \`agent-slack later remove <target>\` â€” remove from Later entirely
  - All accept Slack message URL or channel ID with \`--ts\`
  - Options: \`--workspace <url-or-unique-substring>\`, \`--ts <seconds>.<micros>\`

- \`agent-slack later remind <target> --in <duration>\` â€” set a reminder on a saved item
  - \`--in\` accepts: \`30m\`, \`1h\`, \`3h\`, \`2d\`, \`tomorrow\`, \`monday\`, or a unix timestamp
  - Options: \`--workspace <url-or-unique-substring>\`, \`--ts <seconds>.<micros>\`

$1`;

content = content.replace(regex, newString);
fs.writeFileSync("skills/agent-slack/references/commands.md", content);
