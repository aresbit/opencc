export const WIKI_TOOL_NAME = 'wikitool'

export const DESCRIPTION =
  'Personal wiki knowledge base at ~/yyswiki. Save web content into it, and search/read what is already there. Use search before fetching — the answer may already be in the wiki.'

export function getWikiPrompt(): string {
  return `## wikitool — a knowledge base you can read, not just write

\`~/yyswiki\` is a three-layer knowledge base (its schema is in \`~/yyswiki/CLAUDE.md\`):

1. \`raw_sources/\` — immutable originals, by category
2. \`wiki/\` — the maintained layer: \`index.md\`, \`log.md\`, \`summaries/\`, \`entities/\`, \`concepts/\`
3. \`CLAUDE.md\` — the contract between them

This tool maintains layers 1 and 2. Every save updates \`wiki/index.md\`, which is
what makes the content findable later.

### When to use it

- **\`search\` first, before fetching anything.** If the wiki already has the
  source, refetching wastes a request and creates a near-duplicate. Search is
  cheap and local.
- **\`save\`** when the user shares a URL worth keeping, or when research turns up
  a source you will want again in a later session.
- **\`list\`** to see what the wiki holds in a category.
- **\`get\`** to read back the summary and path of something already saved.

### When NOT to use it

- One-off page reads where nothing needs to persist — use WebFetch.
- Content the user did not ask to keep. The wiki is curated, not a crawl log.
- Facts about the current repository. Those belong in memory or in the code.

### Actions

\`\`\`
wikitool action="search" query="mobile pentesting" [category=…] [limit=…]
wikitool action="list"   [category="article|paper|note|image"]
wikitool action="get"    url="https://…"           # or title="…"
wikitool action="save"   url="https://…" title="…" [description] [category] [tags] [saveMemory]
\`\`\`

### What save does

1. Fetches the URL and **verifies the result is actually content** — an error
   page, a bot wall or a login interstitial is refused, not archived.
2. Writes the original to \`raw_sources/<category>/\`.
3. Extracts a real summary from the document body and writes it to
   \`wiki/summaries/\`.
4. **Upserts a row in \`wiki/index.md\`, keyed by URL.** Re-saving the same URL
   updates its row instead of adding a second one.
5. Appends one line to \`wiki/log.md\` in the documented \`## [date] action | title\`
   format.
6. Optionally saves a companion memory, skipping it if a near-duplicate exists.

If the fetch fails, the failure is recorded under \`wiki/errors/\` with the URL and
reason, so a later attempt knows what was already tried.
`
}
