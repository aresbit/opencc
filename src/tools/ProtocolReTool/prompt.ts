export const PROTOCOL_RE_TOOL_NAME = 'protocolre'

export const DESCRIPTION = `Reverse engineer a network protocol's format and state machine from captured traffic or message samples.

Actions (selected with \`action\`):

**action: "extract"** — turn a pcap (via tshark) or a message-sample file (hex/ascii, one message per line) into normalized hex messages.

**action: "align"** — multiple-sequence-align the messages (Needleman-Wunsch) and report per-column constant-rate + byte entropy, surfacing field-boundary candidates.

**action: "cluster"** — group messages into message types by length (or entropy vector).

**action: "infer_fsm"** — count message-type transitions in capture order and emit a coarse state machine (states + transitions above minSupport).

**action: "report"** — read back the accumulated spec for the current workspace.

**action: "export"** — render the spec to markdown / JSON (P1: Scapy / Wireshark dissector template).

This tool does deterministic inference (alignment / entropy / clustering / transition counting). Field SEMANTICS (which bytes are a length / checksum / enum) are left to you: read the alignment table, reason, and annotate the spec — that is the LLM-appropriate half. Dynamic taint analysis and encrypted-protocol reversal are out of scope (no sandbox).`

export function getPrompt() {
  return `Use \`protocolre\` to reverse a protocol's format + state machine, then hand off (e.g. fuzz via ProbeTool / BashTool, or export a Scapy client).

Workflow:
1. **extract** the messages (pcap via tshark, or a hex/ascii sample file).
2. **align** to see field boundaries: constant columns = static fields, variable low-entropy columns = likely lengths/counters, high-entropy columns = checksums/timestamps/random.
3. **cluster** to group message types, then **infer_fsm** to see the type-transition graph.
4. Read the alignment table with FileRead/Read, reason about field semantics (length/checksum/enum), and annotate.
5. **export** the spec (markdown/json) for downstream use.

Do not claim a field is a length/checksum unless the alignment supports it. Unknown semantics is a valid state — record it, do not invent it.`
}
