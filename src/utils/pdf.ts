import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  PDF_MAX_EXTRACT_SIZE,
  PDF_MAX_PAGES_PER_READ,
  PDF_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { errorMessage } from './errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { getToolResultsDir } from './toolResultStorage.js'

// Lazy-load liteparse — the native module is not available on all platforms
// (e.g. darwin-x64 has no prebuilt binary). A top-level import crashes the
// entire CLI at module-eval time. Dynamic import confines the failure to PDF
// operations so the CLI remains usable.
//
// When liteparse is unavailable, PDF operations gracefully degrade to the
// old code path: base64 document blocks for full reads, poppler-utils
// (pdftoppm / pdfinfo) for page extraction and page counting.
type LiteParseClass = new (...args: any[]) => {
  parse(input: string | Buffer): Promise<{ pages: any[]; text: string }>
  screenshot(filePath: string, pageNumbers: number[]): Promise<Array<{ pageNum: number; imageBuffer: Buffer }>>
}
let _LiteParse: LiteParseClass | null = null
let _liteParseAvailable: boolean | null = null

async function getLiteParse(): Promise<LiteParseClass | null> {
  if (_liteParseAvailable === false) return null
  if (_LiteParse) return _LiteParse
  try {
    const mod = await import('@llamaindex/liteparse')
    _LiteParse = mod.LiteParse
    _liteParseAvailable = true
    return _LiteParse
  } catch {
    _liteParseAvailable = false
    return null
  }
}

/**
 * Check whether liteparse is available (cached for the lifetime of the process).
 * When false, callers should use the old base64 + poppler-utils code path.
 */
export async function isLiteParseAvailable(): Promise<boolean> {
  if (_liteParseAvailable !== null) return _liteParseAvailable
  await getLiteParse()
  return _liteParseAvailable === true
}

export type PDFError = {
  reason:
    | 'empty'
    | 'too_large'
    | 'password_protected'
    | 'corrupted'
    | 'unknown'
    | 'unavailable'
  message: string
}

export type PDFResult<T> =
  | { success: true; data: T }
  | { success: false; error: PDFError }

/**
 * Read a PDF file and return extracted text content.
 *
 * Uses liteparse for native text extraction when available.
 * Gracefully degrades to the old base64-document-block approach when
 * liteparse is not installed (e.g. platforms without native binaries).
 *
 * @param filePath Path to the PDF file
 * @returns Result containing extracted PDF text or base64 data
 */
export async function readPDF(filePath: string): Promise<
  PDFResult<{
    type: 'pdf'
    file: {
      filePath: string
      text: string
      pageCount: number
      originalSize: number
      /** Populated only when falling back to the old base64 code path */
      base64?: string
    }
  }>
> {
  const fs = getFsImplementation()
  let stats: { size: number }
  try {
    stats = await fs.stat(filePath)
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
  const originalSize = stats.size

  if (originalSize === 0) {
    return {
      success: false,
      error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
    }
  }

  if (originalSize > PDF_TARGET_RAW_SIZE) {
    return {
      success: false,
      error: {
        reason: 'too_large',
        message: `PDF file exceeds maximum allowed size of ${formatFileSize(PDF_TARGET_RAW_SIZE)}.`,
      },
    }
  }

  // --- Try liteparse text extraction ---
  const LP = await getLiteParse()
  if (LP) {
    try {
      const parser = new LP({
        ocrEnabled: false,
        quiet: true,
      })
      const result = await parser.parse(filePath)

      if (result.pages.length > 0) {
        return {
          success: true,
          data: {
            type: 'pdf',
            file: {
              filePath,
              text: result.text,
              pageCount: result.pages.length,
              originalSize,
            },
          },
        }
      }
      // If liteparse produced no pages, fall through to base64 fallback
    } catch (e: unknown) {
      const msg = errorMessage(e)
      if (/password/i.test(msg)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message: 'PDF is password-protected. Please provide an unprotected version.',
          },
        }
      }
      // Other liteparse errors — fall through to base64 fallback
    }
  }

  // --- Fallback: base64 document block (old code path) ---
  try {
    const fileBuffer = await readFile(filePath)

    // Validate PDF magic bytes — reject files that aren't actually PDFs
    // (e.g., HTML files renamed to .pdf) before they enter conversation context.
    // Once an invalid PDF document block is in the message history, every subsequent
    // API call fails with 400 "The PDF specified was not valid" and the session
    // becomes unrecoverable without /clear.
    const header = fileBuffer.subarray(0, 5).toString('ascii')
    if (!header.startsWith('%PDF-')) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: `File is not a valid PDF (missing %PDF- header): ${filePath}`,
        },
      }
    }

    const base64 = fileBuffer.toString('base64')

    return {
      success: true,
      data: {
        type: 'pdf',
        file: {
          filePath,
          text: '',
          pageCount: 0,
          base64,
          originalSize,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
}

/**
 * Get the number of pages in a PDF file.
 * Uses liteparse when available, falls back to `pdfinfo` (from poppler-utils).
 * Returns `null` if the page count cannot be determined.
 */
export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  // Try liteparse first
  const LP = await getLiteParse()
  if (LP) {
    try {
      const parser = new LP({
        ocrEnabled: false,
        quiet: true,
      })
      const result = await parser.parse(filePath)
      return result.pages.length
    } catch {
      // Fall through to pdfinfo
    }
  }

  // Fallback: pdfinfo (poppler-utils)
  const { code, stdout } = await execFileNoThrow('pdfinfo', [filePath], {
    timeout: 10_000,
    useCwd: false,
  })
  if (code !== 0) {
    return null
  }
  const match = /^Pages:\s+(\d+)/m.exec(stdout)
  if (!match) {
    return null
  }
  const count = parseInt(match[1]!, 10)
  return isNaN(count) ? null : count
}

export type PDFExtractPagesResult = {
  type: 'parts'
  file: {
    filePath: string
    originalSize: number
    count: number
    outputDir: string
    /** 'png' when liteparse is used, 'jpg' when pdftoppm fallback is used */
    imageFormat?: 'png' | 'jpg'
  }
}

// Caches for liteparse and pdftoppm availability checks
let pdftoppmAvailable: boolean | undefined
let liteparseAvailable: boolean | undefined

/**
 * Reset availability caches. Used by tests only.
 */
export function resetPdftoppmCache(): void {
  pdftoppmAvailable = undefined
  liteparseAvailable = undefined
  _liteParseAvailable = null
  _LiteParse = null
}

/**
 * Check whether PDF page extraction is available.
 * Tries liteparse first, then falls back to checking for the `pdftoppm`
 * binary (from poppler-utils). Results are cached for the lifetime of the process.
 */
export async function isPdftoppmAvailable(): Promise<boolean> {
  // Check liteparse first
  if (liteparseAvailable !== undefined) {
    if (liteparseAvailable) return true
    // liteparse unavailable — check pdftoppm
    if (pdftoppmAvailable !== undefined) return pdftoppmAvailable
  } else {
    const lpAvailable = await isLiteParseAvailable()
    liteparseAvailable = lpAvailable
    if (lpAvailable) return true
  }

  // Fallback: check for pdftoppm binary
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable
  const { code, stderr } = await execFileNoThrow('pdftoppm', ['-v'], {
    timeout: 5000,
    useCwd: false,
  })
  // pdftoppm prints version info to stderr and exits 0 (or sometimes 99 on older versions)
  pdftoppmAvailable = code === 0 || stderr.length > 0
  return pdftoppmAvailable
}

/**
 * Extract PDF pages as images using liteparse (PNG) with pdftoppm (JPEG) fallback.
 * Produces page-01.png or page-01.jpg in an output directory.
 * This enables reading large PDFs and works with all API providers.
 *
 * @param filePath Path to the PDF file
 * @param options Optional page range (1-indexed, inclusive)
 */
export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFExtractPagesResult>> {
  const fs = getFsImplementation()
  let stats: { size: number }
  try {
    stats = await fs.stat(filePath)
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
  const originalSize = stats.size

  if (originalSize === 0) {
    return {
      success: false,
      error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
    }
  }

  if (originalSize > PDF_MAX_EXTRACT_SIZE) {
    return {
      success: false,
      error: {
        reason: 'too_large',
        message: `PDF file exceeds maximum allowed size for page extraction (${formatFileSize(PDF_MAX_EXTRACT_SIZE)}).`,
      },
    }
  }

  // Resolve the page window. parsePDFPageRange may return lastPage: Infinity
  // for open-ended ranges like "5-". Without bounding we'd allocate an infinite
  // page-number array and OOM-crash the runtime, so we cap against the actual
  // page count and PDF_MAX_PAGES_PER_READ before materializing the list.
  const firstPage = Math.max(1, options?.firstPage ?? 1)
  const requestedLast = options?.lastPage ?? firstPage
  let resolvedLast: number
  if (!Number.isFinite(requestedLast)) {
    const totalPages = await getPDFPageCount(filePath)
    if (totalPages === null) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message:
            'Could not determine PDF page count; cannot resolve open-ended page range.',
        },
      }
    }
    resolvedLast = totalPages
  } else {
    resolvedLast = requestedLast
  }
  const cappedLast = Math.min(
    resolvedLast,
    firstPage + PDF_MAX_PAGES_PER_READ - 1,
  )
  if (cappedLast < firstPage) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: `Invalid page range: first=${firstPage} last=${resolvedLast}`,
      },
    }
  }

  // --- Try liteparse screenshot (PNG output) ---
  const LP = await getLiteParse()
  if (LP) {
    try {
      const parser = new LP({ quiet: true, ocrEnabled: false })

      const pageNumbers: number[] = []
      for (let p = firstPage; p <= cappedLast; p++) {
        pageNumbers.push(p)
      }

      const screenshots = await parser.screenshot(filePath, pageNumbers)

      if (screenshots.length > 0) {
        const uuid = randomUUID()
        const outputDir = join(getToolResultsDir(), `pdf-${uuid}`)
        await mkdir(outputDir, { recursive: true })

        for (let i = 0; i < screenshots.length; i++) {
          const s = screenshots[i]!
          const pageNum = s.pageNum.toString().padStart(2, '0')
          await writeFile(join(outputDir, `page-${pageNum}.png`), s.imageBuffer)
        }

        return {
          success: true,
          data: {
            type: 'parts',
            file: {
              filePath,
              originalSize,
              outputDir,
              count: screenshots.length,
              imageFormat: 'png',
            },
          },
        }
      }
      // liteparse produced no pages — fall through to pdftoppm fallback
    } catch {
      // liteparse screenshot failed — fall through to pdftoppm fallback
    }
  }

  // --- Fallback: pdftoppm (JPEG output, poppler-utils) ---
  const available = await isPdftoppmAvailable()
  if (!available) {
    return {
      success: false,
      error: {
        reason: 'unavailable',
        message:
          'PDF page extraction is not available. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering on platforms without liteparse native binaries.',
      },
    }
  }

  const uuid = randomUUID()
  const outputDir = join(getToolResultsDir(), `pdf-${uuid}`)
  await mkdir(outputDir, { recursive: true })

  // pdftoppm produces files like <prefix>-01.jpg, <prefix>-02.jpg, etc.
  const prefix = join(outputDir, 'page')
  const args = ['-jpeg', '-r', '100']
  args.push('-f', String(firstPage))
  args.push('-l', String(cappedLast))
  args.push(filePath, prefix)
  const { code, stderr } = await execFileNoThrow('pdftoppm', args, {
    timeout: 120_000,
    useCwd: false,
  })

  if (code !== 0) {
    if (/password/i.test(stderr)) {
      return {
        success: false,
        error: {
          reason: 'password_protected',
          message:
            'PDF is password-protected. Please provide an unprotected version.',
        },
      }
    }
    if (/damaged|corrupt|invalid/i.test(stderr)) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'PDF file is corrupted or invalid.',
        },
      }
    }
    return {
      success: false,
      error: { reason: 'unknown', message: `pdftoppm failed: ${stderr}` },
    }
  }

  // Read generated image files and sort naturally
  const entries = await readdir(outputDir)
  const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()

  if (imageFiles.length === 0) {
    return {
      success: false,
      error: {
        reason: 'corrupted',
        message: 'pdftoppm produced no output pages. The PDF may be invalid.',
      },
    }
  }

  return {
    success: true,
    data: {
      type: 'parts',
      file: {
        filePath,
        originalSize,
        outputDir,
        count: imageFiles.length,
        imageFormat: 'jpg',
      },
    },
  }
}
