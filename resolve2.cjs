const fs = require('fs');

let content = fs.readFileSync('skills/agent-slack/references/output.md', 'utf-8');

const regex = /<<<<<<< HEAD[\s\S]*?=======\n(## Unreads shape \(high-level\)[\s\S]*?)>>>>>>> e123d29 \(feat: add unreads command for inbox-style unread message view\)/;

const newString = `## Later shape (high-level)

- \`later list\` returns:
  - \`counts: { in_progress, archived, completed, total }\`
  - \`items: [{ channel_id, channel_name, ts, state, date_saved, message? }]\`
  - \`message\` includes \`author\`, \`content\`, \`thread_ts\`, \`reply_count\`
  - Items sorted by most recently saved first
  - With \`--counts-only\`, \`items\` is omitted

- \`later complete/archive/reopen/save/remove\` returns \`{ ok: true }\`
- \`later remind\` returns \`{ ok: true, remind_at }\`

$1`;

content = content.replace(regex, newString);
fs.writeFileSync('skills/agent-slack/references/output.md', content);
