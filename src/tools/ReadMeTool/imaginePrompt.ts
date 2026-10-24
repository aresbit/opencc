import {
  IMAGINE_BASE_PROMPT,
  IMAGINE_MODULE_NAMES,
  IMAGINE_MODULE_ROUTES,
  IMAGINE_PLATFORM_WIDTHS,
  IMAGINE_SECTION_ORDER,
  IMAGINE_SECTION_PROMPTS,
  type ImagineModule,
  type ImaginePlatform,
  type ImagineSection,
} from './imagine_prompt.generated.js'

export {
  IMAGINE_MODULE_NAMES,
  IMAGINE_MODULE_ROUTES,
  IMAGINE_PLATFORM_WIDTHS,
  IMAGINE_SECTION_ORDER,
  IMAGINE_SECTION_PROMPTS,
}
export type { ImagineModule, ImaginePlatform, ImagineSection }

/** Return the target viewport width for a platform. */
export function imaginePlatformWidth(platform: ImaginePlatform): number {
  return IMAGINE_PLATFORM_WIDTHS[platform]
}

/** Return the section names routed to a module, in router order. */
export function imagineModuleSectionNames(
  module: ImagineModule,
): readonly ImagineSection[] {
  return IMAGINE_MODULE_ROUTES[module]
}

function joinParts(
  parts: readonly string[],
  platform: ImaginePlatform,
): string {
  const width = imaginePlatformWidth(platform)
  return `${parts.join('\n\n')}\n\nTarget viewport width: ${width}px.\n`
}

/**
 * Render one module exactly as the Python ``render_imagine_module`` does:
 * the base design system followed by the routed sections in router order.
 */
export function renderImagineModule(
  module: ImagineModule,
  platform: ImaginePlatform = 'desktop',
): string {
  const parts = [
    IMAGINE_BASE_PROMPT,
    ...imagineModuleSectionNames(module).map(
      section => IMAGINE_SECTION_PROMPTS[section],
    ),
  ]
  return joinParts(parts, platform)
}

/**
 * Render several modules as one document.  Shared sections are emitted once,
 * in the canonical section order, so requesting two overlapping modules does
 * not duplicate the palette or UI guidance.
 */
export function renderImagineModules(
  modules: readonly ImagineModule[],
  platform: ImaginePlatform = 'desktop',
): string {
  if (modules.length === 1) {
    return renderImagineModule(modules[0]!, platform)
  }

  const requested = new Set<ImagineSection>()
  for (const module of modules) {
    for (const section of imagineModuleSectionNames(module)) {
      requested.add(section)
    }
  }

  const sections = IMAGINE_SECTION_ORDER.filter(section =>
    requested.has(section),
  ).map(section => IMAGINE_SECTION_PROMPTS[section])

  return joinParts([IMAGINE_BASE_PROMPT, ...sections], platform)
}
