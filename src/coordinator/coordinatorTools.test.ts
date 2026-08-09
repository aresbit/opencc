import { describe, expect, test } from 'bun:test'
import { COORDINATOR_MODE_ALLOWED_TOOLS } from '../constants/tools.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.js'

describe('coordinator tool allowlist', () => {
  test('grants read-only orientation', () => {
    // Without these the coordinator has to guess task boundaries, and guessed
    // boundaries are what produce workers that overlap.
    for (const name of [
      FILE_READ_TOOL_NAME,
      GREP_TOOL_NAME,
      GLOB_TOOL_NAME,
    ]) {
      expect(COORDINATOR_MODE_ALLOWED_TOOLS.has(name)).toBe(true)
    }
  })

  test('withholds every way to author a change', () => {
    // Two failure modes depend on this staying true: a coordinator that can
    // edit stops delegating and the swarm collapses to one slow agent, and a
    // coordinator that authors a candidate can no longer be the independent
    // arbiter the eval/apply ledger assumes it is.
    const authoring = [
      FILE_EDIT_TOOL_NAME,
      FILE_WRITE_TOOL_NAME,
      NOTEBOOK_EDIT_TOOL_NAME,
      ...SHELL_TOOL_NAMES,
    ]
    for (const name of authoring) {
      expect(COORDINATOR_MODE_ALLOWED_TOOLS.has(name)).toBe(false)
    }
  })
})
