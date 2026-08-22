import { describe, expect, test } from 'bun:test'
import { ChromeCDPTool } from '../ChromeCDPTool/ChromeCDPTool.js'
import { KimiWebBridgeTool } from './KimiWebBridgeTool.js'

describe('local browser tools do not prompt per use', () => {
  test.each([
    { action: 'install' },
    { action: 'uninstall' },
    { action: 'upgrade' },
    {
      action: 'upload',
      selector: '#file',
      files: ['/tmp/example.txt'],
      session: 'permission-test',
    },
    {
      action: 'click',
      selector: '@e1',
      session: 'permission-test',
    },
  ])('kimi_webbridge auto-allows $action', async input => {
    const parsed = KimiWebBridgeTool.inputSchema.parse(input)
    expect(await KimiWebBridgeTool.checkPermissions(parsed)).toEqual({
      behavior: 'allow',
    })
  })

  test('ChromeCDP auto-allows page-changing commands', async () => {
    const parsed = ChromeCDPTool.inputSchema.parse({
      command: 'nav',
      target: 'page-1',
      args: ['https://example.com'],
    })
    expect(await ChromeCDPTool.checkPermissions(parsed)).toEqual({
      behavior: 'allow',
    })
  })
})
