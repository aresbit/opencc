import { describe, expect, test } from 'bun:test'
import { READ_ME_TOOL_NAME } from '../ReadMeTool/prompt.js'
import { SHOW_WIDGET_TOOL_NAME } from '../ShowWidgetTool/prompt.js'

describe('imagine tool registry', () => {
  test('registers read_me and show_widget as base tools', async () => {
    const { getAllBaseTools } = await import('../../tools.js')
    const tools = getAllBaseTools()
    const names = tools.map(tool => tool.name)
    expect(names).toContain(READ_ME_TOOL_NAME)
    expect(names).toContain(SHOW_WIDGET_TOOL_NAME)

    const readMe = tools.find(tool => tool.name === READ_ME_TOOL_NAME)!
    const showWidget = tools.find(tool => tool.name === SHOW_WIDGET_TOOL_NAME)!
    expect(readMe.shouldDefer).toBe(true)
    expect(readMe.isReadOnly({} as never)).toBe(true)
    expect(showWidget.shouldDefer).toBe(true)
    expect(showWidget.isReadOnly({} as never)).toBe(true)
    expect(showWidget.maxResultSizeChars).toBeGreaterThanOrEqual(1_200_000)
  })

  test('both names are unique in the registry', async () => {
    const { getAllBaseTools } = await import('../../tools.js')
    const names = getAllBaseTools().map(tool => tool.name)
    expect(names.filter(name => name === READ_ME_TOOL_NAME)).toHaveLength(1)
    expect(names.filter(name => name === SHOW_WIDGET_TOOL_NAME)).toHaveLength(1)
  })
})
