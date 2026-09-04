/**
 * Cross-Turn Knowledge Graph — the session gets smarter over time.
 *
 * Records findings from Grep and Read results into an in-memory
 * knowledge graph. When the same or related patterns are searched
 * later, prior findings are injected as hints to narrow scope.
 *
 * Graph structure:
 *   patterns → Set<filePath>       (grep results index)
 *   files → { symbols, imports }   (read results index)
 *   recent → filePath[]            (LRU of recently touched files)
 */

import type { OnRegistrar } from '../types.js'

interface FileKnowledge {
  symbols: Set<string>
  imports: Set<string>
  lastSeen: number
}

const patternIndex = new Map<string, Set<string>>()
const fileIndex = new Map<string, FileKnowledge>()
const recentFiles: string[] = []

const MAX_PATTERNS = 500
const MAX_FILES = 300
const MAX_RECENT = 50

function recordGrepResult(pattern: string, files: string[]): void {
  if (patternIndex.size >= MAX_PATTERNS) {
    const oldest = patternIndex.keys().next().value
    if (oldest) patternIndex.delete(oldest)
  }
  const existing = patternIndex.get(pattern) ?? new Set()
  for (const f of files) existing.add(f)
  patternIndex.set(pattern, existing)
}

function recordFileRead(filePath: string, content: string): void {
  if (fileIndex.size >= MAX_FILES && !fileIndex.has(filePath)) {
    const oldest = fileIndex.keys().next().value
    if (oldest) fileIndex.delete(oldest)
  }

  const symbols = new Set<string>()
  const imports = new Set<string>()

  const lines = content.split('\n')
  for (const line of lines.slice(0, 200)) {
    // Extract export names
    const exportMatch = line.match(/export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+(\w+)/)
    if (exportMatch) symbols.add(exportMatch[1])

    // Extract import sources
    const importMatch = line.match(/from\s+['"]([^'"]+)['"]/)
    if (importMatch) imports.add(importMatch[1])
  }

  fileIndex.set(filePath, { symbols, imports, lastSeen: Date.now() })

  // Update recent files LRU
  const idx = recentFiles.indexOf(filePath)
  if (idx >= 0) recentFiles.splice(idx, 1)
  recentFiles.unshift(filePath)
  if (recentFiles.length > MAX_RECENT) recentFiles.pop()
}

function findRelatedFiles(pattern: string): string[] {
  const related = new Set<string>()

  // Exact pattern match
  const exact = patternIndex.get(pattern)
  if (exact) for (const f of exact) related.add(f)

  // Substring match on pattern keys
  for (const [key, files] of patternIndex) {
    if (key.includes(pattern) || pattern.includes(key)) {
      for (const f of files) related.add(f)
    }
  }

  // Symbol match in file index
  for (const [filePath, knowledge] of fileIndex) {
    if (knowledge.symbols.has(pattern)) {
      related.add(filePath)
    }
  }

  return [...related].slice(0, 10)
}

export function register(on: OnRegistrar): void {
  // Index Grep results
  on('tool.result', { tool: 'Grep' }, async ($, e: any, next) => {
    const result = await next(e)

    const pattern = e.input?.pattern as string
    if (pattern && result) {
      const files: string[] = []
      if (typeof result === 'string') {
        for (const line of result.split('\n')) {
          const trimmed = line.trim()
          if (trimmed && !trimmed.startsWith('[') && trimmed.includes('/')) {
            files.push(trimmed.split(':')[0])
          }
        }
      } else if (Array.isArray(result)) {
        for (const item of result) {
          if (typeof item === 'string') files.push(item)
          else if (item?.file) files.push(item.file)
        }
      }
      if (files.length > 0) recordGrepResult(pattern, files)
    }

    return result
  })

  // Index Read results
  on('tool.result', { tool: 'Read' }, async ($, e: any, next) => {
    const result = await next(e)

    const filePath = e.input?.file_path as string
    if (filePath && result) {
      const content = typeof result === 'string'
        ? result
        : (result as any)?.content ?? ''
      if (content) recordFileRead(filePath, content)
    }

    return result
  })

  // Enrich Grep calls with prior knowledge
  on('tool.call', { tool: 'Grep' }, async ($, e: any, next) => {
    const pattern = e.input?.pattern as string
    if (pattern) {
      const related = findRelatedFiles(pattern)
      if (related.length > 0 && !e.input?.path) {
        // Attach hints as metadata (doesn't override user-specified path)
        e._knowledgeHint = related
      }
    }
    return next(e)
  })
}

// Query API for other hooks/plugins
export function queryFiles(pattern: string): string[] {
  return findRelatedFiles(pattern)
}

export function getRecentFiles(): readonly string[] {
  return recentFiles
}

export function getFileSymbols(filePath: string): string[] {
  const knowledge = fileIndex.get(filePath)
  return knowledge ? [...knowledge.symbols] : []
}

export function getStats(): { patterns: number; files: number; recent: number } {
  return {
    patterns: patternIndex.size,
    files: fileIndex.size,
    recent: recentFiles.length,
  }
}

export function clearKnowledge(): void {
  patternIndex.clear()
  fileIndex.clear()
  recentFiles.length = 0
}
