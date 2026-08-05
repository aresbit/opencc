import { errorMessage } from './errors.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'

/**
 * Office-document text extraction backed by `@firecrawl/anydoc`.
 *
 * anydoc is a Rust/NAPI module that converts Word, PowerPoint, Excel,
 * OpenDocument, RTF and EPUB files into GitHub-Flavored Markdown. It ships
 * prebuilt binaries for darwin-{x64,arm64}, linux-{x64,arm64}-{gnu,musl} and
 * win32-x64 only — every other platform (win32-arm64, linux-armv7, freebsd,
 * Android/Termux, ...) has no binary and the `require` inside the package's
 * loader throws.
 *
 * So this module mirrors the lazy-load contract used for liteparse in
 * `./pdf.ts`: the import is dynamic and its failure is cached, confining an
 * unsupported platform to "office documents can't be read here" instead of
 * crashing the CLI at module-eval time.
 */

/** Extensions anydoc converts, without the leading dot. */
const OFFICE_EXTENSIONS = new Set([
  // Word
  'doc',
  'docx',
  'docm',
  // PowerPoint
  'ppt',
  'pptx',
  'pptm',
  'ppsx',
  'ppsm',
  'pps',
  'pot',
  // Excel
  'xls',
  'xlsx',
  'xlsm',
  'xlsb',
  // OpenDocument
  'odt',
  'ods',
  'odp',
  // Other containers
  'rtf',
  'epub',
])

/**
 * Whether an extension names an office document handled by anydoc.
 *
 * PDF and CSV are deliberately excluded even though anydoc supports them:
 * PDFs go through liteparse (see `./pdf.ts`) which also renders page images,
 * and CSV is plain text that reads better with line numbers.
 *
 * @param ext Extension with or without a leading dot; case-insensitive.
 */
export function isOfficeExtension(ext: string): boolean {
  const normalized = ext.replace(/^\./, '').toLowerCase()
  return OFFICE_EXTENSIONS.has(normalized)
}

type AnydocModule = {
  toMarkdown(path: string): Promise<string>
}

let _anydoc: AnydocModule | null = null
let _anydocAvailable: boolean | null = null

async function getAnydoc(): Promise<AnydocModule | null> {
  if (_anydocAvailable === false) return null
  if (_anydoc) return _anydoc
  try {
    const mod = await import('@firecrawl/anydoc')
    _anydoc = mod as AnydocModule
    _anydocAvailable = true
    return _anydoc
  } catch {
    _anydocAvailable = false
    return null
  }
}

/**
 * Check whether anydoc has a usable native binary on this platform
 * (cached for the lifetime of the process).
 */
export async function isAnydocAvailable(): Promise<boolean> {
  if (_anydocAvailable !== null) return _anydocAvailable
  await getAnydoc()
  return _anydocAvailable === true
}

/**
 * Reset the availability cache. Used by tests only.
 */
export function resetAnydocCache(): void {
  _anydoc = null
  _anydocAvailable = null
}

export type OfficeDocError = {
  reason: 'empty' | 'too_large' | 'unsupported' | 'unavailable'
  message: string
}

export type OfficeDocResult =
  | {
      success: true
      data: { markdown: string; originalSize: number }
    }
  | { success: false; error: OfficeDocError }

/**
 * Convert an office document to Markdown.
 *
 * Conversion problems come back as `{ success: false }`; filesystem errors
 * (ENOENT and friends) are thrown so callers can inspect the errno.
 *
 * @param filePath Absolute path to the document
 * @param maxSizeBytes Reject files larger than this before invoking anydoc —
 *   conversion is done fully in memory.
 */
export async function readOfficeDocument(
  filePath: string,
  maxSizeBytes: number,
): Promise<OfficeDocResult> {
  const anydoc = await getAnydoc()
  if (!anydoc) {
    return {
      success: false,
      error: {
        reason: 'unavailable',
        message:
          'Office document conversion is unavailable: @firecrawl/anydoc has no prebuilt native binary for this platform ' +
          `(${process.platform}-${process.arch}). Convert the file to a text format first, e.g. with LibreOffice: ` +
          '`soffice --headless --convert-to txt <file>`.',
      },
    }
  }

  // Deliberately unguarded: an ENOENT here has to reach FileReadTool's caller
  // with its errno intact so the "did you mean ...?" suggestion still fires.
  const { size } = await getFsImplementation().stat(filePath)

  if (size === 0) {
    return {
      success: false,
      error: { reason: 'empty', message: 'Document is empty (0 bytes).' },
    }
  }

  if (size > maxSizeBytes) {
    return {
      success: false,
      error: {
        reason: 'too_large',
        message:
          `Document (${formatFileSize(size)}) exceeds the maximum size for conversion ` +
          `(${formatFileSize(maxSizeBytes)}).`,
      },
    }
  }

  let markdown: string
  try {
    markdown = await anydoc.toMarkdown(filePath)
  } catch (error) {
    // anydoc reports password-protected, corrupted and image-only files as
    // plain errors — surface its message rather than guessing a reason.
    return {
      success: false,
      error: {
        reason: 'unsupported',
        message: `Could not convert this document: ${errorMessage(error)}`,
      },
    }
  }

  if (!markdown.trim()) {
    return {
      success: false,
      error: {
        reason: 'empty',
        message:
          'The document converted to empty text. It may contain only images ' +
          '(which need OCR) or no extractable content.',
      },
    }
  }

  return { success: true, data: { markdown, originalSize: size } }
}
