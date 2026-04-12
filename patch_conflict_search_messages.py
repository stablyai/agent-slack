import sys

with open("src/slack/search-messages.ts", "r") as f:
    content = f.read()

# Fix 1
content = content.replace("""<<<<<<< HEAD
): Promise<SearchMessageResult> {
||||||| a015952
): Promise<Omit<CompactSlackMessage, "channel_id" | "thread_ts">[]> {
=======
): Promise<SearchCompactMessage[]> {
>>>>>>> origin/main""", "): Promise<SearchMessageResult> {")

# Fix 2
content = content.replace("""<<<<<<< HEAD
  const resolvedMessages: SlackMessageSummary[] = [];
  const out: Omit<CompactSlackMessage, "channel_id" | "thread_ts">[] = [];
||||||| a015952
  const out: Omit<CompactSlackMessage, "channel_id" | "thread_ts">[] = [];
=======
  const out: SearchCompactMessage[] = [];
>>>>>>> origin/main""", """  const resolvedMessages: SlackMessageSummary[] = [];
  const out: SearchCompactMessage[] = [];""")

# Fix 3
content = content.replace("""<<<<<<< HEAD
    resolvedMessages.push(full);
    out.push(stripThreadListFields(compact));
||||||| a015952
    out.push(stripThreadListFields(compact));
=======
    out.push(toSearchCompactMessage(compact, ref.permalink));
>>>>>>> origin/main""", """    resolvedMessages.push(full);
    out.push(toSearchCompactMessage(compact, ref.permalink));""")

# Fix 4
content = content.replace("""<<<<<<< HEAD
): Promise<SearchMessageResult> {
||||||| a015952
): Promise<Omit<CompactSlackMessage, "channel_id" | "thread_ts">[]> {
=======
): Promise<SearchCompactMessage[]> {
>>>>>>> origin/main""", "): Promise<SearchMessageResult> {")

# Fix 5
content = content.replace("""<<<<<<< HEAD
        matchedSummaries.push(summary);
        results.push(stripThreadListFields(compact));
||||||| a015952
        results.push(stripThreadListFields(compact));
=======
        results.push(toSearchCompactMessage(compact));
>>>>>>> origin/main""", """        matchedSummaries.push(summary);
        results.push(toSearchCompactMessage(compact));""")

# Fix 6 (update SearchMessageResult type to use SearchCompactMessage instead of Omit<CompactSlackMessage, "channel_id" | "thread_ts">)
content = content.replace(
    '  messages: Omit<CompactSlackMessage, "channel_id" | "thread_ts">[];',
    '  messages: SearchCompactMessage[];'
)

# And remove stripThreadListFields which is now unused since main introduced toSearchCompactMessage
import re
content = re.sub(r'function stripThreadListFields\([\s\S]*?\}\n\n', '', content)

with open("src/slack/search-messages.ts", "w") as f:
    f.write(content)
