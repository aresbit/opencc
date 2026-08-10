import { describe, expect, test } from 'bun:test'
import { getCodeActRuntimeStatuses } from '../../../utils/codeActLanguageAdapters.js'
import { CodeActTool } from '../CodeActTool.js'
import { getCodeActPrompt } from '../prompt.js'

/**
 * Two things kept CodeAct in glue-script territory, and neither was a bug in
 * the sandbox — the runtime was always capable of far more than it was used
 * for.
 *
 * The first was delivery: "only stdout reaches the model" meant anything
 * visual could be computed and never handed over, so plotting was structurally
 * pointless. The second was the prompt, whose "when to use" list described a
 * better shell script and whose one ambitious line — Python's data science
 * ecosystem — was false, since nothing is preinstalled. A model that tries
 * `import numpy`, gets ModuleNotFoundError, and is told CodeAct is for awk
 * chains learns exactly the lesson it appeared to learn.
 */

const PNG_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function mapResult(stdout: string, extra: Partial<{ stderr: string; exitCode: number; success: boolean }> = {}) {
  return CodeActTool.mapToolResultToToolResultBlockParam!(
    {
      success: extra.success ?? true,
      stdout,
      stderr: extra.stderr ?? '',
      exitCode: extra.exitCode ?? 0,
    } as never,
    'tu_1',
  )
}

describe('CodeAct image delivery', () => {
  test('a lone data URI comes back as an image, not a wall of base64', () => {
    const block = mapResult(PNG_URI) as { content: unknown }
    expect(Array.isArray(block.content)).toBe(true)
    const first = (block.content as { type: string; source: { media_type: string } }[])[0]!
    expect(first.type).toBe('image')
    expect(first.source.media_type).toBe('image/png')
  })

  test('ordinary stdout is still text', () => {
    const block = mapResult('accuracy 0.997') as { content: unknown }
    expect(typeof block.content).toBe('string')
    expect(block.content).toContain('accuracy 0.997')
  })

  test('text that merely mentions a data URI is not treated as an image', () => {
    // The match is anchored, so prose about the convention stays prose.
    const block = mapResult(`print a ${PNG_URI} to deliver a plot`) as {
      content: unknown
    }
    expect(typeof block.content).toBe('string')
  })

  test('the empty-output nudge still fires', () => {
    const block = mapResult('') as { content: string }
    expect(block.content).toMatch(/produced no output/)
  })

  test('stderr on a successful run is still surfaced', () => {
    const block = mapResult('ok', { stderr: 'DeprecationWarning' }) as {
      content: string
    }
    expect(block.content).toContain('DeprecationWarning')
  })
})

describe('CodeAct prompt scope', () => {
  const prompt = () => getCodeActPrompt(getCodeActRuntimeStatuses())

  test('no longer claims a preinstalled data science ecosystem', () => {
    // Nothing is preinstalled; the old line offered NumPy/pandas as a reason to
    // choose CodeAct, and the first ModuleNotFoundError taught the opposite.
    const text = prompt()
    expect(text).not.toMatch(/You need Python's data science ecosystem/)
    expect(text).toMatch(/standard library only/)
  })

  test('says how to actually get the packages', () => {
    const text = prompt()
    expect(text).toMatch(/pip install/)
    expect(text).toMatch(/persist for later CodeAct calls/)
  })

  test('raises the ceiling past glue scripts', () => {
    const text = prompt()
    expect(text).toMatch(/Build the thing/)
    expect(text).toMatch(/floor, not the ceiling/)
  })

  test('names the ambitious shapes concretely, not as "complex tasks"', () => {
    // "use it for hard things" is not actionable. The worked shapes are.
    const text = prompt()
    expect(text).toMatch(/backprop/)
    expect(text).toMatch(/dual numbers|reverse-mode/)
    expect(text).toMatch(/data:image\/png;base64/)
  })

  test('points at persistKey for work that spans calls', () => {
    expect(prompt()).toMatch(/persistKey/)
  })

  test('still tells the model to report numbers rather than "it worked"', () => {
    expect(prompt()).toMatch(/state the result numerically/)
  })
})

describe('CodeAct artifact manifest in the result', () => {
  test('lists produced files with a path that resolves', () => {
    const block = mapResult('trained', {}) as { content: string }
    expect(block.content).toBe('trained')

    const withFiles = CodeActTool.mapToolResultToToolResultBlockParam!(
      {
        success: true,
        stdout: 'final loss 0.02',
        stderr: '',
        exitCode: 0,
        artifacts: [
          { relPath: 'metrics.csv', path: '/durable/metrics.csv', bytes: 2048 },
        ],
        artifactsTruncated: false,
      } as never,
      'tu_1',
    ) as { content: string }
    expect(withFiles.content).toContain('final loss 0.02')
    expect(withFiles.content).toContain('metrics.csv')
    expect(withFiles.content).toContain('/durable/metrics.csv')
  })

  test('a silent run that wrote files is not scolded for printing nothing', () => {
    // The nudge exists for a script that forgot to print. A script that wrote
    // its result to disk did not forget anything.
    const block = CodeActTool.mapToolResultToToolResultBlockParam!(
      {
        success: true,
        stdout: '',
        stderr: '',
        exitCode: 0,
        artifacts: [{ relPath: 'out.bin', path: '/durable/out.bin', bytes: 10 }],
      } as never,
      'tu_1',
    ) as { content: string }
    expect(block.content).not.toMatch(/produced no output/)
    expect(block.content).toContain('out.bin')
  })
})

describe('CodeAct prompt: long work and Rust', () => {
  const prompt = () => getCodeActPrompt(getCodeActRuntimeStatuses())

  test('documents that files come back', () => {
    expect(prompt()).toMatch(/Files are a first-class result/)
  })

  test('documents background runs and what they are for', () => {
    const text = prompt()
    expect(text).toMatch(/run_in_background/)
    expect(text).toMatch(/poll_run_id/)
    expect(text).toMatch(/limit on \*waiting\*/)
  })

  test('steers compute-heavy work to Rust', () => {
    const text = prompt()
    expect(text).toMatch(/Prefer Rust for anything compute-heavy/)
    // Both halves of the argument, since either alone is a weaker case.
    expect(text).toMatch(/orders of magnitude faster/)
    expect(text).toMatch(/no data races|memory-safe|use-after-free/)
  })

  test('does not overclaim Rust — names where Python still wins', () => {
    expect(prompt()).toMatch(/Python remains the right choice/)
  })

  test('keeps the std-only constraint next to the Rust advice', () => {
    expect(prompt()).toMatch(/std-only/)
  })
})

describe('CodeAct tool metadata', () => {
  test('the description advertises the image path', async () => {
    expect(await CodeActTool.description!({} as never, {} as never)).toMatch(
      /data:image/,
    )
  })

  test('persistKey is described as a way to build up, not only to promote', () => {
    const shape = (CodeActTool.inputSchema as { shape: Record<string, { description?: string }> }).shape
    expect(shape.persistKey?.description).toMatch(/build a program up/)
  })
})
