export interface DataflowNode {
  id: string
  successors?: string[]
  gen?: string[]
  kill?: string[]
}

export interface DataflowArtifact {
  direction: 'forward' | 'backward'
  meet: 'union' | 'intersection'
  universe?: string[]
  initialFacts?: string[]
  boundary?: Array<{ node: string; facts: string[] }>
  nodes: DataflowNode[]
}

export interface DataflowState {
  id: string
  in: string[]
  out: string[]
}

export interface DataflowReport {
  iterations: number
  converged: boolean
  states: DataflowState[]
  diagnostics: string[]
}

function unique(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort()
}

function equal(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) if (!b.has(value)) return false
  return true
}

function transfer(input: Set<string>, gen: string[], kill: string[]): Set<string> {
  const output = new Set(input)
  for (const fact of kill) output.delete(fact)
  for (const fact of gen) output.add(fact)
  return output
}

function meetSets(sets: Set<string>[], kind: 'union' | 'intersection', universe: Set<string>): Set<string> {
  if (kind === 'union') {
    const result = new Set<string>()
    for (const set of sets) for (const value of set) result.add(value)
    return result
  }
  if (sets.length === 0) return new Set(universe)
  const result = new Set(sets[0])
  for (const value of result) {
    if (sets.slice(1).some(set => !set.has(value))) result.delete(value)
  }
  return result
}

export function solveDataflow(artifact: DataflowArtifact): DataflowReport {
  if (!artifact || !Array.isArray(artifact.nodes) || artifact.nodes.length === 0) {
    throw new Error('Dataflow artifact must contain at least one node.')
  }
  if (artifact.direction !== 'forward' && artifact.direction !== 'backward') {
    throw new Error('direction must be "forward" or "backward".')
  }
  if (artifact.meet !== 'union' && artifact.meet !== 'intersection') {
    throw new Error('meet must be "union" or "intersection".')
  }

  const ids = new Set<string>()
  for (const node of artifact.nodes) {
    if (!node.id) throw new Error('Every dataflow node needs a non-empty id.')
    if (ids.has(node.id)) throw new Error(`Duplicate dataflow node id: ${node.id}`)
    ids.add(node.id)
  }
  for (const node of artifact.nodes) {
    for (const successor of node.successors ?? []) {
      if (!ids.has(successor)) throw new Error(`Node ${node.id} references unknown successor ${successor}.`)
    }
  }

  const boundary = new Map<string, Set<string>>()
  for (const item of artifact.boundary ?? []) {
    if (!ids.has(item.node)) throw new Error(`Boundary references unknown node ${item.node}.`)
    if (boundary.has(item.node)) throw new Error(`Duplicate boundary for node ${item.node}.`)
    boundary.set(item.node, new Set(unique(item.facts)))
  }

  const universe = new Set(unique(artifact.universe))
  for (const fact of artifact.initialFacts ?? []) universe.add(fact)
  for (const item of artifact.boundary ?? []) for (const fact of item.facts) universe.add(fact)
  for (const node of artifact.nodes) {
    for (const fact of node.gen ?? []) universe.add(fact)
    for (const fact of node.kill ?? []) universe.add(fact)
  }
  const initial = new Set(
    artifact.initialFacts ?? (artifact.meet === 'intersection' ? [...universe] : []),
  )

  const predecessors = new Map<string, string[]>()
  for (const id of ids) predecessors.set(id, [])
  for (const node of artifact.nodes) {
    for (const successor of node.successors ?? []) predecessors.get(successor)!.push(node.id)
  }
  const byId = new Map(artifact.nodes.map(node => [node.id, node]))
  const inFacts = new Map<string, Set<string>>()
  const outFacts = new Map<string, Set<string>>()
  for (const id of ids) {
    inFacts.set(id, new Set(initial))
    outFacts.set(id, new Set(initial))
  }

  const queue = artifact.nodes.map(node => node.id)
  const queued = new Set(queue)
  let iterations = 0
  const maxIterations = Math.max(1, artifact.nodes.length * Math.max(1, universe.size + 1) * 4)

  while (queue.length > 0 && iterations < maxIterations) {
    const id = queue.shift()!
    queued.delete(id)
    iterations++
    const node = byId.get(id)!
    const gen = unique(node.gen)
    const kill = unique(node.kill)
    const oldIn = inFacts.get(id)!
    const oldOut = outFacts.get(id)!
    let nextIn: Set<string>
    let nextOut: Set<string>

    if (artifact.direction === 'forward') {
      nextIn = boundary.get(id) ?? meetSets((predecessors.get(id) ?? []).map(pred => outFacts.get(pred)!), artifact.meet, universe)
      nextOut = transfer(nextIn, gen, kill)
    } else {
      nextOut = boundary.get(id) ?? meetSets((node.successors ?? []).map(succ => inFacts.get(succ)!), artifact.meet, universe)
      nextIn = transfer(nextOut, gen, kill)
    }

    if (!equal(oldIn, nextIn) || !equal(oldOut, nextOut)) {
      inFacts.set(id, new Set(nextIn))
      outFacts.set(id, new Set(nextOut))
      const affected = artifact.direction === 'forward' ? node.successors ?? [] : predecessors.get(id) ?? []
      for (const other of affected) {
        if (!queued.has(other)) {
          queue.push(other)
          queued.add(other)
        }
      }
    }
  }

  const converged = queue.length === 0
  return {
    iterations,
    converged,
    states: artifact.nodes.map(node => ({
      id: node.id,
      in: [...inFacts.get(node.id)!].sort(),
      out: [...outFacts.get(node.id)!].sort(),
    })),
    diagnostics: [
      `${artifact.direction} ${artifact.meet} fixed point over ${artifact.nodes.length} nodes and ${universe.size} facts.`,
      artifact.meet === 'intersection'
        ? 'Intersection used the declared/derived universe as the empty-edge identity and default initial value.'
        : 'Union used the empty set as the empty-edge identity and default initial value.',
      'The solver implements GEN/KILL transfer only; non-bit-vector transfer functions require a dedicated abstract domain.',
    ],
  }
}

export function formatDataflowReport(report: DataflowReport): string {
  const rows = report.states.map(state => `${state.id}: IN={${state.in.join(', ')}} OUT={${state.out.join(', ')}}`)
  return [
    `Dataflow ${report.converged ? 'reached a fixed point' : 'stopped before convergence'} after ${report.iterations} node evaluations.`,
    ...rows,
    '',
    ...report.diagnostics.map(item => `- ${item}`),
  ].join('\n')
}
