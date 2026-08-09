/** Signed text returned by connector-backed API responses. */
export type ConnectorTextBlock = {
  type: 'connector_text'
  connector_text: string
  signature?: string
}

export type ConnectorTextDelta = {
  type: 'connector_text_delta'
  connector_text: string
}

export function isConnectorTextBlock(
  block: unknown,
): block is ConnectorTextBlock {
  if (typeof block !== 'object' || block === null) return false

  const candidate = block as Record<string, unknown>
  return (
    candidate.type === 'connector_text' &&
    typeof candidate.connector_text === 'string' &&
    (candidate.signature === undefined ||
      typeof candidate.signature === 'string')
  )
}
