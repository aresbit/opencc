import { describe, expect, test } from 'bun:test'
import { getCoordinatorSystemPrompt } from './coordinatorMode.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import type { Tools } from '../Tool.js'
import {
  applyCoordinatorToolFilter,
  mergeAndFilterTools,
} from '../utils/toolPool.js'

describe('coordinator capabilities', () => {
  test('does not filter ordinary, specialist, skill, or MCP tools', () => {
    const names = [
      FILE_READ_TOOL_NAME,
      GREP_TOOL_NAME,
      GLOB_TOOL_NAME,
      BASH_TOOL_NAME,
      FILE_EDIT_TOOL_NAME,
      FILE_WRITE_TOOL_NAME,
      NOTEBOOK_EDIT_TOOL_NAME,
      'Skill',
      'kimi_webbridge',
      'mcp__example__arbitrary_tool',
    ]
    const tools = names.map(name => ({ name })) as unknown as Tools
    expect(applyCoordinatorToolFilter(tools).map(tool => tool.name)).toEqual(
      names,
    )
    const mergedNames = mergeAndFilterTools([], tools, 'default').map(
      tool => tool.name,
    )
    expect(mergedNames).toHaveLength(names.length)
    expect(new Set(mergedNames)).toEqual(new Set(names))
  })

  test('lets the coordinator decide whether to implement or delegate', () => {
    const prompt = getCoordinatorSystemPrompt()
    expect(prompt).toContain('fully capable implementation agent')
    expect(prompt).toContain('Handle work directly')
    expect(prompt).toContain('Edit, Write and NotebookEdit')
    expect(prompt).not.toContain('You have no Edit, Write or shell access')
  })
})
