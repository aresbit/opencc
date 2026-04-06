import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage } from '../../types/message.js'
import type { ToolCallProgress } from '../../Tool.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().url().describe('The URL to fetch content from'),
    title: z.string().describe('Title for the saved content'),
    description: z.string().describe('Brief description of the content').optional(),
    category: z.enum(['article', 'paper', 'note', 'image']).default('article').describe('Content category'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    saveMemory: z.boolean().default(true).describe('Whether to save as memory file'),
    memoryType: z.enum(['user', 'feedback', 'project', 'reference']).default('project').describe('Type of memory to save').optional(),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
    sourceFile: z.string().describe('Path to saved source file'),
    memoryFile: z.string().optional().describe('Path to saved memory file'),
    url: z.string().describe('The URL that was fetched'),
    title: z.string().describe('Title of the content'),
    message: z.string().describe('Status message'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

function sanitizeFilename(title: string): string {
  return title
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '') // Remove special chars, keep Chinese characters
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_') // Replace multiple underscores with single
    .trim()
}

function getCategoryDirectory(category: string): string {
  const directories: Record<string, string> = {
    article: 'articles',
    paper: 'papers',
    note: 'notes',
    image: 'images',
  }
  return directories[category] || 'articles'
}

function getWikiBasePath(): string {
  // Allow override via environment variable
  if (process.env.WIKI_BASE_PATH) {
    return process.env.WIKI_BASE_PATH
  }
  const home = process.env.HOME || '/Users/mac'
  return `${home}/yyswiki`
}

export const WikiTool = buildTool({
  name: 'wikitool',
  searchHint: 'fetch and save content to wiki knowledge base',
  maxResultSizeChars: 100_000,
  shouldDefer: false,
  isMcp: false,
  async description(input, options) {
    const basePath = getWikiBasePath()
    const envNote = process.env.WIKI_BASE_PATH ? ' (custom path via WIKI_BASE_PATH env var)' : ' (default path, can be customized via WIKI_BASE_PATH env var)'
    return `Fetch web content and save it to the personal wiki knowledge base at ${basePath}/raw_sources/. Can also save as memory file.${envNote}`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async prompt(options) {
    const basePath = getWikiBasePath()
    const envNote = process.env.WIKI_BASE_PATH ? ' (custom path via WIKI_BASE_PATH env var)' : ' (default path, can be customized via WIKI_BASE_PATH env var)'
    return `Fetch web content and save it to the personal wiki knowledge base at ${basePath}/raw_sources/. Can also save as memory file.${envNote}`
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async call(input, context, canUseTool, parentMessage, onProgress) {
    console.error('WikiTool called with input:', input);
    try {
      // Step 1: Fetch content using WebFetchTool
      onProgress?.({
        status: 'running',
        message: `Fetching content from ${input.url}`,
      })

      const fetchResult = await canUseTool({
        name: 'WebFetch',
        input: {
          url: input.url,
          prompt: `Extract the main content from this page and convert it to clean markdown format. Include title: ${input.title}`,
          mode: 'auto',
          format: 'markdown',
        },
        parentMessage,
      })

      if (!fetchResult.success) {
        throw new Error(`Failed to fetch content: ${fetchResult.error || 'Unknown error'}`)
      }

      const content = fetchResult.result.result

      // Step 2: Save to raw_sources directory
      onProgress?.({
        status: 'running',
        message: `Saving content to wiki knowledge base`,
      })

      const sanitizedTitle = sanitizeFilename(input.title)
      const categoryDir = getCategoryDirectory(input.category)
      const filename = `${sanitizedTitle}.md`
      const wikiBasePath = getWikiBasePath()
      const filePath = `${wikiBasePath}/raw_sources/${categoryDir}/${filename}`

      // Create directory if it doesn't exist
      const mkdirResult = await canUseTool({
        name: 'Bash',
        input: {
          command: `mkdir -p "${wikiBasePath}/raw_sources/${categoryDir}"`,
        },
        parentMessage,
      })

      if (!mkdirResult.success) {
        throw new Error(`Failed to create directory: ${mkdirResult.error || 'Unknown error'}`)
      }

      // Create markdown file with metadata
      const markdownContent = `# ${input.title}

${input.description ? `> ${input.description}\n\n` : ''}**Source URL**: ${input.url}
**Fetched**: ${new Date().toISOString().split('T')[0]}
**Category**: ${input.category}
${input.tags && input.tags.length > 0 ? `**Tags**: ${input.tags.join(', ')}\n\n` : '\n'}

---

${content}
`

      const writeResult = await canUseTool({
        name: 'Write',
        input: {
          file_path: filePath,
          content: markdownContent,
        },
        parentMessage,
      })

      if (!writeResult.success) {
        throw new Error(`Failed to write file: ${writeResult.error || 'Unknown error'}`)
      }

      let memoryFilePath = ''

      // Step 3: Save as memory file if requested
      if (input.saveMemory) {
        onProgress?.({
          status: 'running',
          message: `Saving as memory file`,
        })

        const memoryType = input.memoryType || 'project'
        const memoryName = `wiki_${sanitizedTitle}`
        const memoryDescription = `Wiki content: ${input.title} from ${input.url}`

        const memoryContent = `## Wiki Content: ${input.title}

**URL**: ${input.url}
**Category**: ${input.category}
**Saved**: ${new Date().toISOString()}
**Source File**: ${filePath}

### Summary
${input.description || 'Content saved from web source'}

### Key Points
- Source: ${input.url}
- Type: ${input.category}
- Tags: ${input.tags ? input.tags.join(', ') : 'none'}

### Why:
This content was fetched and saved as part of building a personal knowledge base. It represents information that may be useful for future reference, research, or analysis.

### How to apply:
Refer to this memory when working with related topics. The source file contains the full content in markdown format.
`

        const memoryResult = await canUseTool({
          name: 'MemoryTool',
          input: {
            action: 'save',
            type: memoryType,
            name: memoryName,
            description: memoryDescription,
            content: memoryContent,
            tags: ['wiki', input.category, ...(input.tags || [])],
          },
          parentMessage,
        })

        if (!memoryResult.success) {
          console.warn(`Warning: Failed to save memory: ${memoryResult.error || 'Unknown error'}`)
          // Continue even if memory save fails
        } else {
          memoryFilePath = memoryResult.result.memory?.filePath || ''
        }
      }

      // Step 4: Update wiki index or log if needed
      onProgress?.({
        status: 'running',
        message: `Updating wiki logs`,
      })

      // Add entry to wiki log
      const logEntry = `## [${new Date().toISOString().split('T')[0]}] ingest | ${input.title}
- Source: ${input.url}
- Category: ${input.category}
- File: ${filename}
- Memory: ${input.saveMemory ? 'saved' : 'not saved'}`

      // Ensure wiki directory exists
      const mkdirLogResult = await canUseTool({
        name: 'Bash',
        input: {
          command: `mkdir -p "${wikiBasePath}/wiki"`,
        },
        parentMessage,
      })

      if (!mkdirLogResult.success) {
        console.warn(`Warning: Failed to create wiki directory: ${mkdirLogResult.error || 'Unknown error'}`)
      }

      // Append to log file using bash (filewrite doesn't support append)
      const logResult = await canUseTool({
        name: 'Bash',
        input: {
          command: `echo '${logEntry.replace(/'/g, "'\"'\"'")}' >> "${wikiBasePath}/wiki/log.md"`,
        },
        parentMessage,
      })

      // Log update is optional, don't fail if it doesn't work
      if (!logResult.success) {
        console.warn(`Warning: Failed to update log: ${logResult.error || 'Unknown error'}`)
      }

      onProgress?.({
        status: 'completed',
        message: `Successfully saved content to wiki`,
      })

      return {
        success: true,
        sourceFile: filePath,
        memoryFile: memoryFilePath,
        url: input.url,
        title: input.title,
        message: `Successfully saved "${input.title}" to wiki knowledge base at ${filePath}`,
      }

    } catch (error) {
      return {
        success: false,
        sourceFile: '',
        url: input.url,
        title: input.title,
        message: `Failed to save content to wiki: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
})