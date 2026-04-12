import sys

with open("src/slack/search.ts", "r") as f:
    content = f.read()

content = content.replace("""<<<<<<< HEAD
import type { CompactSlackMessage } from "./messages.ts";
import type { CompactSlackUser } from "./users.ts";
||||||| a015952
import type { CompactSlackMessage } from "./messages.ts";
=======
>>>>>>> origin/main""", """import type { CompactSlackMessage } from "./messages.ts";
import type { CompactSlackUser } from "./users.ts";""")

with open("src/slack/search.ts", "w") as f:
    f.write(content)
