import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { ReadMeTool } from '../ReadMeTool.js'
import {
  IMAGINE_MODULE_NAMES,
  IMAGINE_SECTION_ORDER,
  IMAGINE_SECTION_PROMPTS,
  type ImagineModule,
  renderImagineModule,
  renderImagineModules,
} from '../imaginePrompt.js'
import { IMAGINE_SOURCE_SHA256 } from '../imagine_prompt.generated.js'
import { DESCRIPTION, getPrompt } from '../prompt.js'

const TEST_DIR = import.meta.dir
const OPENCC_ROOT = path.resolve(TEST_DIR, '../../../..')
const REPO_ROOT = path.resolve(OPENCC_ROOT, '../..')
const SOURCE_PATH = path.join(
  REPO_ROOT,
  'backend/src/autoagent_backend/domain/imagine_prompt.py',
)
const GENERATED_PATH = path.join(TEST_DIR, '../imagine_prompt.generated.ts')
const GENERATOR_PATH = path.join(
  OPENCC_ROOT,
  'scripts/generate-imagine-assets.py',
)

const EXPECTED_HEADINGS: Record<string, string> = {
  palette: '### Color palette',
  ui: '### UI components',
  svg: '### SVG guide',
  diagram: '### Diagram rules',
  data_viz: '### Charts and data visualization',
  art: '### Art and illustration',
  elicitation: '### Interactive forms',
}

function callTool(input: Record<string, unknown>) {
  return ReadMeTool.call(input as never, {} as never)
}

/** Render one module through the tool and return its output data. */
async function readModule(
  modules: ImagineModule | ImagineModule[],
  platform: 'desktop' | 'mobile' | 'unknown' = 'desktop',
) {
  const result = await callTool({ modules, platform })
  return result.data
}

describe('read_me router', () => {
  test('exposes exactly the seven Imagine modules', () => {
    expect([...IMAGINE_MODULE_NAMES]).toEqual([
      'diagram',
      'mockup',
      'interactive',
      'data_viz',
      'art',
      'chart',
      'elicitation',
    ])
  })

  test('diagram routes palette, svg, and diagram', () => {
    const text = renderImagineModule('diagram', 'desktop')
    expect(text).toContain('## Imagine — visual creation')
    expect(text).toContain(EXPECTED_HEADINGS.palette!)
    expect(text).toContain(EXPECTED_HEADINGS.svg!)
    expect(text).toContain(EXPECTED_HEADINGS.diagram!)
    expect(text).not.toContain(EXPECTED_HEADINGS.elicitation!)
    expect(text).toContain('Target viewport width: 680px.')
  })

  test('chart keeps the Python router order: ui, palette, data_viz', () => {
    const text = renderImagineModule('chart')
    const positions = [
      EXPECTED_HEADINGS.ui!,
      EXPECTED_HEADINGS.palette!,
      EXPECTED_HEADINGS.data_viz!,
    ].map(heading => text.indexOf(heading))
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  test('every module renders its base design system and routed sections', () => {
    const routes: Record<ImagineModule, string[]> = {
      diagram: ['palette', 'svg', 'diagram'],
      mockup: ['ui', 'palette'],
      interactive: ['ui', 'palette'],
      data_viz: ['ui', 'palette', 'data_viz'],
      art: ['svg', 'art'],
      chart: ['ui', 'palette', 'data_viz'],
      elicitation: ['elicitation'],
    }
    for (const module of IMAGINE_MODULE_NAMES) {
      const text = renderImagineModule(module)
      expect(text).toContain('## Imagine — visual creation')
      for (const section of routes[module]) {
        expect(text).toContain(EXPECTED_HEADINGS[section]!)
      }
    }
  })

  test('multiple modules emit shared sections once in canonical order', () => {
    const text = renderImagineModules(['chart', 'diagram'], 'desktop')
    const positions = IMAGINE_SECTION_ORDER.map(name =>
      text.indexOf(
        name === 'palette'
          ? EXPECTED_HEADINGS.palette!
          : EXPECTED_HEADINGS[name]!,
      ),
    ).filter(position => position >= 0)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    for (const heading of Object.values(EXPECTED_HEADINGS)) {
      expect(text.split(heading).length - 1).toBeLessThanOrEqual(1)
    }
    expect(text).toContain('Target viewport width: 680px.')
  })

  test('documents the module and platform defaults', () => {
    expect(DESCRIPTION).toContain('`modules` defaults to `diagram`')
    expect(DESCRIPTION).toContain('`platform` defaults to `desktop`')
    expect(getPrompt()).toContain('Defaults to `diagram`')
    expect(getPrompt()).toContain('Defaults to `desktop`')
  })
})

describe('read_me platform widths', () => {
  test('mobile is 380px and desktop/unknown are 680px', () => {
    expect(renderImagineModule('diagram', 'mobile')).toContain(
      'Target viewport width: 380px.',
    )
    expect(renderImagineModule('diagram', 'desktop')).toContain(
      'Target viewport width: 680px.',
    )
    expect(renderImagineModule('diagram', 'unknown')).toContain(
      'Target viewport width: 680px.',
    )
  })

  test('input schema rejects an unknown module or platform', () => {
    const schema = ReadMeTool.inputSchema
    expect(() => schema.parse({ modules: 'unknown' })).toThrow()
    expect(() =>
      schema.parse({ modules: 'diagram', platform: 'tablet' }),
    ).toThrow()
  })

  test('accepts a single module or an array and defaults to diagram/desktop', () => {
    const schema = ReadMeTool.inputSchema
    expect(schema.parse({ modules: 'diagram' })).toMatchObject({
      modules: 'diagram',
      platform: 'desktop',
    })
    expect(schema.parse({ modules: ['chart', 'diagram'] })).toMatchObject({
      modules: ['chart', 'diagram'],
      platform: 'desktop',
    })
    expect(schema.parse({})).toMatchObject({
      modules: 'diagram',
      platform: 'desktop',
    })
  })
})

describe('read_me tool output', () => {
  test('defaults to diagram and desktop when modules are omitted', async () => {
    const result = await callTool({})
    expect(result.data.success).toBe(true)
    expect(result.data.modules).toEqual(['diagram'])
    expect(result.data.platform).toBe('desktop')
    expect(result.data.width).toBe(680)
    expect(result.data.text).toContain(EXPECTED_HEADINGS.diagram!)
  })

  test('returns the module text, platform, and width', async () => {
    const data = await readModule('diagram', 'mobile')
    expect(data.success).toBe(true)
    expect(data.modules).toEqual(['diagram'])
    expect(data.platform).toBe('mobile')
    expect(data.width).toBe(380)
    expect(data.text).toContain(EXPECTED_HEADINGS.palette!)
    expect(data.text).toContain('Target viewport width: 380px.')
  })

  test('returns combined text for an array of modules', async () => {
    const data = await readModule(['chart', 'art'])
    expect(data.success).toBe(true)
    expect(data.modules).toEqual(['chart', 'art'])
    expect(data.text).toContain(EXPECTED_HEADINGS.data_viz!)
    expect(data.text).toContain(EXPECTED_HEADINGS.art!)
  })

  test('is read-only, concurrent, deferred, and non-destructive', () => {
    expect(ReadMeTool.isReadOnly({} as never)).toBe(true)
    expect(ReadMeTool.isConcurrencySafe({} as never)).toBe(true)
    expect(ReadMeTool.isDestructive({} as never)).toBe(false)
    expect(ReadMeTool.shouldDefer).toBe(true)
  })
})

describe('generated asset consistency', () => {
  test('records the SHA-256 of the Python source of truth', async () => {
    const source = await readFile(SOURCE_PATH)
    const digest = createHash('sha256').update(source).digest('hex')
    expect(IMAGINE_SOURCE_SHA256).toBe(digest)
  })

  test('contains every section and module from the checked-in asset', () => {
    for (const section of IMAGINE_SECTION_ORDER) {
      expect(IMAGINE_SECTION_PROMPTS[section].length).toBeGreaterThan(0)
    }
    expect(IMAGINE_MODULE_NAMES.length).toBe(7)
  })

  const python = Bun.which('python3')
  test.skipIf(!python)(
    'regenerating from the Python source reproduces the checked-in file',
    async () => {
      const result = Bun.spawnSync({
        cmd: [python!, GENERATOR_PATH, '--stdout'],
        cwd: OPENCC_ROOT,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(result.exitCode).toBe(0)
      const generated = await readFile(GENERATED_PATH, 'utf8')
      expect(result.stdout.toString()).toBe(generated)
    },
  )
})
