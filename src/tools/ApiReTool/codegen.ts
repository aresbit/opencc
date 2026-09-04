import type { Endpoint } from './har.js'

export const SUPPORTED_LANGUAGES = ['python', 'typescript'] as const
export type Language = (typeof SUPPORTED_LANGUAGES)[number]

const PARTIALS: Record<Language, string> = {
  python: [
    '- Use `requests` with a `Session`.',
    '- Model each endpoint as a typed function; use `dataclass` for response shapes.',
    '- Read secrets (cookies/tokens) from environment variables — never hardcode them.',
    '- Include a small `if __name__ == "__main__":` example that hits one endpoint and prints the result.',
  ].join('\n'),
  typescript: [
    '- Use native `fetch` (Node 18+).',
    '- Model each endpoint as a typed function returning an `interface`.',
    '- Read secrets from `process.env` — never hardcode them.',
    '- Export a runnable example that hits one endpoint and logs the result.',
  ].join('\n'),
}

export function languagePartial(lang: Language): string {
  return PARTIALS[lang]
}

export function buildBrief(
  endpoints: Endpoint[],
  lang: Language,
  workspaceId: string,
): string {
  const endpointLines = endpoints
    .map(
      e =>
        `- ${e.method} ${e.pathPattern}  (query: ${e.params.query.join(', ') || '-'}, body: ${e.params.body.join(', ') || '-'}, auth: ${e.authCandidates.join(', ') || '-'}, status: ${e.statusCodes.join(',')})`,
    )
    .join('\n')

  return `Generate a ${lang} API client for these endpoints inferred from captured traffic (workspace ${workspaceId}).

## Endpoints
${endpointLines || '(none)'}

## Language requirements
${languagePartial(lang)}

## Verification (hard requirement)
1. Write the client to a file.
2. Run it against one real endpoint (Bash). It must exit 0 and return a sane result.
3. Iterate up to 5 attempts; fix what breaks.
4. Report ONLY after it actually runs — do not claim it works without running it.

## Secrets
Read cookies/tokens from environment variables. Never write plaintext tokens to disk.
`
}
