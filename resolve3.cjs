const fs = require('fs');

let content = fs.readFileSync('src/index.ts', 'utf-8');

content = content.replace(/<<<<<<< HEAD\nimport { registerLaterCommand } from "\.\/cli\/later-command\.ts";\n\|\|\|\|\|\|\| parent of e123d29 \(feat: add unreads command for inbox-style unread message view\)\n=======\nimport { registerUnreadsCommand } from "\.\/cli\/unreads-command\.ts";\n>>>>>>> e123d29 \(feat: add unreads command for inbox-style unread message view\)/, 
  'import { registerLaterCommand } from "./cli/later-command.ts";\nimport { registerUnreadsCommand } from "./cli/unreads-command.ts";');

content = content.replace(/<<<<<<< HEAD\nregisterLaterCommand\(\{ program, ctx \}\);\n\|\|\|\|\|\|\| parent of e123d29 \(feat: add unreads command for inbox-style unread message view\)\n=======\nregisterUnreadsCommand\(\{ program, ctx \}\);\n>>>>>>> e123d29 \(feat: add unreads command for inbox-style unread message view\)/, 
  'registerLaterCommand({ program, ctx });\nregisterUnreadsCommand({ program, ctx });');

fs.writeFileSync('src/index.ts', content);
