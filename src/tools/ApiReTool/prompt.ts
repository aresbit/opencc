export const API_RE_TOOL_NAME = 'apire'

export const DESCRIPTION = `Reverse engineer a website's HTTP API from captured traffic (HAR), then generate a typed client.

Actions (selected with \`action\`):

**action: "capture"** — read a HAR file (\`source: "har"\` + \`harPath\`) and normalize it into a request list (static assets filtered out, auth headers redacted). P1: \`source: "kimi_webbridge"\`.

**action: "infer"** — cluster the requests into endpoints (method + normalized pathPattern), and deterministically extract query/body params and auth-header candidates.

**action: "export"** — render the endpoint list to markdown / JSON.

**action: "generate_client"** — build a generation brief (endpoint list + language template + verification requirement) for you to write and run a client. The tool does NOT write the client — you do, then run it, iterate, and report only when it actually works.

**action: "report"** — read back the workspace.

Field SEMANTICS (which auth flow, required vs optional params, types) are left to you — the tool does deterministic normalization only.

SECURITY: HAR files contain cookies/tokens/PII. capture redacts known sensitive headers (authorization/cookie/set-cookie) to \`<redacted>\`; the endpoint list keeps only the presence/name of auth headers, never their values. Generated clients must read secrets from environment variables — never hardcode tokens to disk.`

export function getPrompt() {
  return `Use \`apire\` to turn captured HTTP traffic into an endpoint list and a working client.

Workflow:
1. Capture traffic first (kimi_webbridge network capture, or an existing HAR file), then call \`capture\` with the HAR path.
2. \`infer\` to cluster endpoints and extract params/auth candidates.
3. Read the endpoint list, reason about the auth flow (which header, whether it needs re-auth), and call \`generate_client\` for a brief.
4. Write the client (FileWrite), run it (Bash), iterate up to a few attempts, and report only after it actually works.

Never hardcode tokens/cookies into the client — read them from environment variables. Never claim the client works unless you ran it.`
}
