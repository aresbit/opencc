import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt } from './prompt'

const inputSchema = lazySchema(() =>
  z.strictObject({
    arxivId: z.string().describe('arXiv ID or URL (e.g., "1706.03762" or "https://arxiv.org/abs/1706.03762")'),
    framework: z.enum(['pytorch', 'jax', 'tensorflow', 'none']).optional().default('pytorch').describe('Framework for implementation'),
    mode: z.enum(['minimal', 'full', 'educational']).optional().default('minimal').describe('Generation mode'),
    outputDir: z.string().optional().describe('Output directory (default: ./paper2code_output/{arxiv_id}/)'),
    installIfMissing: z.boolean().optional().default(false).describe('Install paper2code skill if missing'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the operation succeeded'),
    message: z.string().describe('Status message'),
    outputDir: z.string().optional().describe('Output directory containing generated files'),
    files: z.array(z.string()).optional().describe('Generated files'),
    paperTitle: z.string().optional().describe('Paper title'),
    paperAuthors: z.array(z.string()).optional().describe('Paper authors'),
    installed: z.boolean().optional().describe('Whether paper2code was installed'),
    skillAvailable: z.boolean().optional().describe('Whether paper2code skill is available'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const Paper2CodeTool = buildTool({
  name: 'paper2code',
  searchHint: 'Generate code from arXiv papers',
  maxResultSizeChars: 100_000,
  async description(input: any, options: any) {
    return DESCRIPTION
  },
  async prompt(options: {
    getToolPermissionContext: () => Promise<any>
    tools: any[]
    agents: any[]
    allowedAgentTypes?: string[]
  }) {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema
  },
  userFacingName() {
    return 'Paper2CodeTool'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `paper2code ${input.arxivId}`
  },
  async call(input, context, canUseTool, parentMessage, onProgress) {
    const { arxivId, framework, mode, outputDir, installIfMissing } = input

    // Create output directory
    const outputPath = outputDir || `./paper2code_output/${arxivId.replace(/[^a-zA-Z0-9]/g, '_')}`

    try {
      // Report progress
      onProgress?.({
        type: 'info',
        message: `Starting paper2code processing for arXiv ID: ${arxivId}`,
      })

      // First check if paper2code skill is available
      let skillAvailable = false
      try {
        // Try to use the SkillTool to check if paper2code is available
        const skillResult = await canUseTool('skill', {
          skill: 'paper2code',
          args: `--help`,
        })
        skillAvailable = skillResult.success
      } catch (error) {
        skillAvailable = false
      }

      if (!skillAvailable && installIfMissing) {
        onProgress?.({
          type: 'info',
          message: 'paper2code skill not found. Installing...',
        })

        // Try to install paper2code skill
        const installResult = await canUseTool('bash', {
          command: 'npx skills add PrathamLearnsToCode/paper2code/skills/paper2code',
          description: 'Install paper2code skill',
        })

        if (installResult.success) {
          skillAvailable = true
          onProgress?.({
            type: 'info',
            message: 'paper2code skill installed successfully.',
          })
        } else {
          return {
            success: false,
            message: `Failed to install paper2code skill: ${installResult.stderr || installResult.stdout || 'Unknown error'}. Please install manually with: npx skills add PrathamLearnsToCode/paper2code/skills/paper2code`,
            installed: false,
            skillAvailable: false,
          }
        }
      }

      if (skillAvailable) {
        // Use the paper2code skill via SkillTool
        onProgress?.({
          type: 'info',
          message: `Running paper2code skill with arXiv ID: ${arxivId}`,
        })

        const skillResult = await canUseTool('skill', {
          skill: 'paper2code',
          args: `${arxivId} --framework ${framework} --mode ${mode}`,
        })

        if (skillResult.success) {
          return {
            success: true,
            message: `Paper2Code processing completed for arXiv ID: ${arxivId}. Check output in current directory.`,
            outputDir: '.',
            skillAvailable: true,
            installed: installIfMissing && !skillAvailable,
          }
        } else {
          return {
            success: false,
            message: `paper2code skill failed: ${skillResult.stderr || skillResult.stdout || 'Unknown error'}`,
            skillAvailable: true,
            installed: installIfMissing && !skillAvailable,
          }
        }
      } else {
        // Fallback: use local Python scripts from /tmp/paper2code
        onProgress?.({
          type: 'info',
          message: 'Using local paper2code scripts from /tmp/paper2code',
        })

        // Check if scripts exist
        const checkResult = await canUseTool('bash', {
          command: 'test -f /tmp/paper2code/skills/paper2code/scripts/fetch_paper.py && echo "Scripts found" || echo "Scripts missing"',
          description: 'Check if paper2code scripts exist',
        })

        if (!checkResult.stdout?.includes('Scripts found')) {
          return {
            success: false,
            message: `paper2code scripts not found in /tmp/paper2code. Please:
1. Install the paper2code skill manually: npx skills add PrathamLearnsToCode/paper2code/skills/paper2code
2. Or clone the repository: git clone git@github.com:aresbit/paper2code.git /tmp/paper2code
3. Or set installIfMissing: true to install automatically`,
            skillAvailable: false,
            installed: false,
          }
        }

        // Run the fetch script
        const bashResult = await canUseTool('bash', {
          command: `cd /tmp/paper2code && python3 skills/paper2code/scripts/fetch_paper.py "${arxivId}" "${outputPath}"`,
          description: 'Run paper2code fetch script',
        })

        if (!bashResult.success) {
          return {
            success: false,
            message: `Failed to fetch paper: ${bashResult.stderr || bashResult.stdout || 'Unknown error'}`,
            skillAvailable: false,
            installed: false,
          }
        }

        onProgress?.({
          type: 'info',
          message: 'Paper fetched successfully. For full code generation, install the paper2code skill.',
        })

        return {
          success: true,
          message: `Paper fetched successfully for arXiv ID: ${arxivId}. Output directory: ${outputPath}. Note: For full code generation, install the paper2code skill with: npx skills add PrathamLearnsToCode/paper2code/skills/paper2code`,
          outputDir: outputPath,
          files: ['paper_text.md', 'paper_metadata.json'],
          skillAvailable: false,
          installed: false,
        }
      }
    } catch (error) {
      return {
        success: false,
        message: `Error in Paper2CodeTool: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  },
})