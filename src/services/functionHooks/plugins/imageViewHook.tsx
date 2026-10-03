/**
 * Image thumbnail row — renders the "prompt-images" slot.
 *
 * PromptInput mounts <HookSlot id="prompt-images" props={{ images, columns,
 * maxRows }} /> above the prompt whenever the draft references pasted images.
 * This hook is the only thing that ever renders into it: the slot's native
 * node is null, so with no hook registered nothing changes.
 *
 * It is a pure function of its props — no state, no timers, no file writes.
 * The layout math lives in utils/imageThumbnail (fitRow) so it can be tested
 * apart from rendering; this file only resolves a size per image and turns
 * the resulting cells into Ink boxes.
 *
 * Sizes: prefer the pixel size the paste recorded (c.dimensions); when it is
 * absent but the stored file path is known, read the PNG IHDR header off disk
 * (synchronous by design — see pngSizeFromFile). When neither is available the
 * size is null, which fitRow resolves to FALLBACK_SIZE.
 *
 * SYNCHRONOUS render path: this runs inside a React render pass and MUST
 * return a node, never a Promise. A Promise here is dropped as a plugin bug
 * by uiDispatcher.
 */

import * as React from 'react'
import { existsSync } from 'fs'
import { pathToFileURL } from 'url'
import { Box, Text } from '../../../ink.js'
import Link from '../../../ink/components/Link.js'
import { supportsHyperlinks } from '../../../ink/supports-hyperlinks.js'
import type { OnRegistrar } from '../types.js'
import {
  fitRow,
  normalizeThumbSize,
  pngSizeFromFile,
  type RawThumbSize,
} from '../../../utils/imageThumbnail.js'

export interface PromptImageView {
  n: number
  path: string | null
  /**
   * Pixel dimensions as the paste recorded them. Two shapes reach here: a
   * plain { width, height } and the app's ImageDimensions
   * ({ originalWidth, originalHeight, displayWidth, displayHeight });
   * normalizeThumbSize is the single place that knows how to read either.
   */
  size: RawThumbSize
}

export interface PromptImagesProps {
  images: readonly PromptImageView[]
  columns: number
  maxRows: number
}

/** Cell size a tile falls back to when fitRow returned nothing for it. */
const DEFAULT_CELLS = { columns: 4, rows: 1 }

export function register(on: OnRegistrar): void {
  on('ui.slot.render', { slotId: 'prompt-images' }, ($, e: any, _next) => {
    const props = e.props as PromptImagesProps | undefined
    if (!props || !Array.isArray(props.images)) {
      return e.node
    }
    // An outer hook may have rewritten this slot's props, so treat the array
    // as untrusted: a malformed entry must not throw inside React's
    // synchronous render pass and take the whole frame down with it — the same
    // reason uiDispatcher drops hooks that return a Promise rather than
    // awaiting them. Drop anything that is not a usable descriptor before it
    // reaches the layout.
    const images = props.images.filter(
      (img): img is PromptImageView => img != null && typeof img === 'object',
    )
    if (images.length === 0) {
      return e.node
    }

    // Resolve the true pixel size: normalize whatever shape the paste
    // recorded (plain {width,height} or ImageDimensions); if that yields
    // nothing and the file is really on disk, read the PNG header; else null
    // (→ FALLBACK_SIZE inside fitRow).
    const resolvedPaths = images.map(img =>
      img.path && existsSync(img.path) ? img.path : null,
    )
    const sizes = images.map((img, i) => {
      const fromRecorded = normalizeThumbSize(img.size)
      if (fromRecorded) return fromRecorded
      if (resolvedPaths[i]) return pngSizeFromFile(resolvedPaths[i] as string)
      return null
    })
    const cells = fitRow(sizes, props.maxRows, props.columns)

    return (
      <Box flexDirection="row" columnGap={1}>
        {images.map((image, i) => {
          const cell = cells[i] ?? DEFAULT_CELLS
          const resolvedSize = sizes[i]
          const filePath = resolvedPaths[i]
          // No usable size means no thumbnail, and the marker is the same
          // whether the paste recorded no dimensions, the file has since gone,
          // or the file is not a readable PNG. Emitting an empty body for the
          // last case (as an earlier version did) made a broken file look like
          // a working image with nothing in it; guessing a shape from nothing
          // is what produced the 'undefined×undefined' tiles before that.
          const label = resolvedSize
            ? `${resolvedSize.width}×${resolvedSize.height}`
            : 'no preview'
          // On a hyperlink-capable terminal the label opens the cached PNG —
          // the only way to actually see it when the terminal has no graphics
          // protocol, and it matches how message images already behave.
          const href =
            filePath && supportsHyperlinks() ? pathToFileURL(filePath).href : null
          return (
            <Box
              key={`img-${image.n}`}
              flexDirection="column"
              alignItems="center"
              borderStyle="round"
              borderDimColor
            >
              <Box
                width={cell.columns}
                height={cell.rows}
                alignItems="center"
                justifyContent="center"
              >
                <Text dimColor wrap="truncate">
                  {label}
                </Text>
              </Box>
              {href ? (
                <Link url={href}>
                  <Text dimColor>#{image.n}</Text>
                </Link>
              ) : (
                <Text dimColor>#{image.n}</Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
