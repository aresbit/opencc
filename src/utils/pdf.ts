import { LiteParse } from '@llamaindex/liteparse'
import { randomUUID } from 'crypto'
import { mkdir, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  PDF_MAX_EXTRACT_SIZE,
  PDF_MAX_PAGES_PER_READ,
  PDF_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { errorMessage } from './errors.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { getToolResultsDir } from './toolResultStorage.js'

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
 * Read a PDF file and return extracted text content using liteparse.
 * Replaces the old base64-document-block approach with native text extraction.
 *
 * @param filePath Path to the PDF file
 * @returns Result containing extracted PDF text or a structured error
 */
export async function readPDF(filePath: string): Promise<
  PDFResult<{
    type: 'pdf'
    file: {
      filePath: string
      text: string
      pageCount: number
      originalSize: number
    }
  }>
> {
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(filePath)
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

    const parser = new LiteParse({
      ocrEnabled: false,
      quiet: true,
    })
    const result = await parser.parse(filePath)

    if (result.pages.length === 0) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'PDF parsing produced no pages. The file may be invalid or corrupted.',
        },
      }
    }

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
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: msg,
      },
    }
  }
}

/**
 * Get the number of pages in a PDF file using liteparse.
 * Returns `null` if the page count cannot be determined.
 */
export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  try {
    const parser = new LiteParse({
      ocrEnabled: false,
      quiet: true,
    })
    const result = await parser.parse(filePath)
    return result.pages.length
  } catch {
    return null
  }
}

export type PDFExtractPagesResult = {
  type: 'parts'
  file: {
    filePath: string
    originalSize: number
    count: number
    outputDir: string
  }
}

// liteparse availability is always true since it's bundled as a dependency.
// Kept for backward compatibility with existing callers.
let liteparseAvailable: boolean | undefined

/**
 * Reset the liteparse availability cache. Used by tests only.
 */
export function resetPdftoppmCache(): void {
  liteparseAvailable = undefined
}

/**
 * Check whether liteparse is available.
 * Always true since it's installed as a npm dependency.
 * Kept for backward compatibility — replaces the old pdftoppm check.
 */
export async function isPdftoppmAvailable(): Promise<boolean> {
  if (liteparseAvailable !== undefined) return liteparseAvailable
  try {
    const parser = new LiteParse({ quiet: true, maxPages: 1, ocrEnabled: false })
    liteparseAvailable = true
    return true
  } catch {
    liteparseAvailable = false
    return false
  }
}

/**
 * Extract PDF pages as PNG images using liteparse's screenshot feature.
 * Produces page-01.png, page-02.png, etc. in an output directory.
 * This enables reading large PDFs and works with all API providers.
 *
 * @param filePath Path to the PDF file
 * @param options Optional page range (1-indexed, inclusive)
 */
export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFExtractPagesResult>> {
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(filePath)
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

    const parser = new LiteParse({ quiet: true, ocrEnabled: false })

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

    const pageNumbers: number[] = []
    for (let p = firstPage; p <= cappedLast; p++) {
      pageNumbers.push(p)
    }

    const screenshots = await parser.screenshot(filePath, pageNumbers)

    if (screenshots.length === 0) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'liteparse produced no output pages. The PDF may be invalid.',
        },
      }
    }

    // Write screenshots to output directory
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
