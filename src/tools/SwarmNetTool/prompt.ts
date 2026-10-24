export const DESCRIPTION = `Stigmergic Viterbi Routing for actor-to-actor messages.

ActorTool delivers one envelope to one mailbox. SwarmNet adds a learned routing
layer on top: it keeps per-edge success posteriors, latency and pheromone,
plans relay chains with max-sum Viterbi over live actors, and re-fits its
scoring weights from delivery episodes.

Actions:
- status: current policy version, edge health, replay-buffer size.
- plan: return top-K relay chains and scores. No message is sent.
- observe: record a delivery outcome. Omit "path" and Viterbi decodes the most
  likely chain from src, dst and end-to-end latency; the posterior confidence
  becomes the credit-assignment weight.
- send: plan a chain, then hand the envelope to the first hop. Hops before the
  destination forward it when they run "pump". Use expect_ack_ms when you need
  proof the final receiver consumed it.
- pump: drain only swarm.relay envelopes from your own mailbox, forward each
  one hop, and record the hop outcome. Normal ActorTool mail is left untouched.
- learn: decay pheromone and re-fit the routing policy on the episode buffer.
  A new policy is adopted only when it beats the incumbent on held-out pairs.
- announce: publish this session's capabilities, roles, load and status to the
  local Agent-DNS registry. The resident swarm-daemon puts it in LAN beacons.
- discover: list peers learned over Agent-DNS (address, capabilities, roles,
  node). Use it before planning a cross-host route.

Agent-DNS is discovery, not delivery: beacons are HMAC-signed when
OPENCC_DNS_TOKEN/OPENCC_ACTORD_TOKEN is set, and mail still moves through the
actor mailbox/actord. Run one "opencc swarm-daemon" per host to pump relay
queues for every local actor and keep beacons flowing.

When to use it: multi-hop work where several live sessions can carry or hand off
messages, or when you want routing quality to improve from observed delivery
outcomes. For a single direct message, ActorTool is simpler and has less
overhead. SwarmNet never mutates code or prompts; "self-improvement" here means
a versioned routing policy gated by validation accuracy.`
