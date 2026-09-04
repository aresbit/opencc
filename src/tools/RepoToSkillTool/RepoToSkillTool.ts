import { readFile, readdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { DESCRIPTION, getPrompt, REPO_TO_SKILL_TOOL_NAME } from './prompt.js'
import { addSkillDirectories } from '../../skills/loadSkillsDir.js'
import {
  CLONE_COMMAND_TIMEOUT_MS,
  detectRepoType,
  ensureDir,
  fileExists,
  registeredSkillDir,
  runCommand,
  skillNameFor,
  skillStoreDir,
  slugFromRepo,
  workspaceDir,
} from './runtime.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['distill', 'register', 'list'])
      .optional()
      .default('distill')
      .describe(
        '"distill" clones a repo and returns a distillation brief. "register" writes a skill into the skill store and hot-loads it. "list" lists registered repo-skills.',
      ),
    repo: z
      .string()
      .optional()
      .describe(
        'Repository URL (e.g. https://github.com/owner/repo). Required for "distill"; used for slug derivation in "register" when skillName is absent.',
      ),
    task: z
      .string()
      .optional()
      .describe(
        'Optional description of the capability to extract, for task-oriented distillation.',
      ),
    skillDir: z
      .string()
      .optional()
      .describe(
        'For "register": path to a directory you already wrote containing SKILL.md (optionally references/ and scripts/).',
      ),
    skillName: z
      .string()
      .optional()
      .describe('For "register": explicit skill name/slug override (defaults to repo-derived slug).'),
    skillContent: z
      .string()
      .optional()
      .describe(
        'For "register": full SKILL.md markdown (YAML frontmatter with name+description, then body), supplied inline.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    success: z.boolean().describe('Whether the action completed'),
    action: z.string().describe('The action that ran'),
    message: z.string().describe('Human-readable summary'),
    slug: z.string().optional().describe('Derived slug (owner-repo)'),
    skillName: z.string().optional().describe('Registered skill name'),
    skillPath: z.string().optional().describe('Registered skill directory'),
    workspace: z.string().optional().describe('Clone workspace for "distill"'),
    repoKind: z.string().optional().describe('Detected repo type for "distill"'),
    manifest: z.string().optional().describe('Manifest file detected for "distill"'),
    hints: z.array(z.string()).optional().describe('Key files/hints for "distill"'),
    skills: z
      .array(
        z.object({ name: z.string(), slug: z.string(), description: z.string() }),
      )
      .optional()
      .describe('Registered repo-skills for "list"'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function failure(action: string, message: string): { data: Output } {
  return { data: { success: false, action, message } }
}

function renderToolUseMessage(input: Partial<Input>): string | null {
  if (input.action === 'list') return 'repo2skill list'
  if (input.action === 'register') {
    return input.skillDir
      ? `repo2skill register ${input.skillDir}`
      : 'repo2skill register'
  }
  if (!input.repo) return null
  return `repo2skill ${input.repo}`
}

/** Read up to maxBytes from a file, or null if it does not exist. */
async function readHead(path: string, maxBytes: number): Promise<string | null> {
  try {
    const content = await readFile(path, { encoding: 'utf-8' })
    return content.length > maxBytes ? content.slice(0, maxBytes) + '\n…' : content
  } catch {
    return null
  }
}

function readSkillDescription(content: string): string {
  // Pull the `description:` line out of the frontmatter for the list view.
  const m = content.match(/^description:\s*(.+)$/m)
  return m ? m[1].trim() : ''
}

export const RepoToSkillTool = buildTool({
  name: REPO_TO_SKILL_TOOL_NAME,
  searchHint:
    'turn a GitHub repository into a reusable skill (distill + register + list)',
  maxResultSizeChars: 50_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get inputJSONSchema() {
    const schema = zodToJsonSchema(inputSchema())
    schema.type = 'object'
    return schema
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'RepoToSkillTool'
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
    return input.action === 'list'
      ? 'repo2skill list'
      : input.action === 'register'
        ? `repo2skill register ${input.skillDir ?? input.repo ?? ''}`
        : `repo2skill ${input.repo ?? ''}`
  },
  renderToolUseMessage,
  async call(input, context) {
    const signal = context.abortController.signal
    if (input.action === 'register') return runRegister(input, signal)
    if (input.action === 'list') return runList(signal)
    return runDistill(input, signal)
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const result = output as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: result.success
        ? result.message
        : `repo2skill ${result.action} failed: ${result.message}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)

async function runDistill(
  input: Input,
  signal: AbortSignal,
): Promise<{ data: Output }> {
  if (!input.repo) {
    return failure('distill', 'repo is required for action "distill".')
  }
  const slug = slugFromRepo(input.repo)
  const ws = workspaceDir(slug)

  try {
    await ensureDir(ws)

    // Shallow clone. Nothing in the repo is ever executed here.
    let cloneOutput: string
    if (await fileExists(join(ws, '.git'))) {
      cloneOutput = '(existing clone reused)'
    } else {
      const result = await runCommand(
        ['git', 'clone', '--depth', '1', input.repo.trim(), ws],
        { signal, timeoutMs: CLONE_COMMAND_TIMEOUT_MS },
      )
      if (result.exitCode !== 0) {
        return failure(
          'distill',
          `git clone failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
        )
      }
      cloneOutput = result.stdout.trim()
    }

    const { kind, manifest } = await detectRepoType(ws)
    const entries = await readdir(ws).catch(() => [] as string[])
    const readme = entries.find(e => /^readme(\.md|\.txt|\.rst)?$/i.test(e))
    const readmeHead = readme ? await readHead(join(ws, readme), 1500) : null

    const hints: string[] = []
    if (manifest) hints.push(`manifest: ${manifest}`)
    if (readmeHead) hints.push(`README (${readme}) head: ${readmeHead}`)
    hints.push(`top-level entries: ${entries.slice(0, 30).join(', ')}`)
    if (input.task) hints.push(`task to extract: ${input.task}`)

    return {
      data: {
        success: true,
        action: 'distill',
        message: [
          `Cloned ${input.repo} into ${ws}`,
          `Detected type: ${kind}`,
          cloneOutput ? `git: ${cloneOutput}` : '',
          '',
          'Now read the key files named in "hints", author a SKILL.md (frontmatter name/description + "how to install / use / verify / gotchas" body), and call repo2skill action "register" with skillDir or skillContent.',
        ]
          .filter(Boolean)
          .join('\n'),
        slug,
        workspace: ws,
        repoKind: kind,
        manifest: manifest ?? undefined,
        hints,
      },
    }
  } catch (error) {
    return failure(
      'distill',
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function runRegister(
  input: Input,
  signal: AbortSignal,
): Promise<{ data: Output }> {
  if (!input.skillDir && !input.skillContent) {
    return failure(
      'register',
      'skillDir or skillContent is required for action "register".',
    )
  }

  const slug = input.skillName
    ? slugFromRepo(input.skillName)
    : input.repo
      ? slugFromRepo(input.repo)
      : null
  if (!slug) {
    return failure('register', 'could not derive a slug; pass repo or skillName.')
  }

  try {
    let content: string
    if (input.skillContent) {
      content = input.skillContent
    } else {
      const source = await readHead(join(input.skillDir!, 'SKILL.md'), 1_000_000)
      if (!source) {
        return failure('register', `no SKILL.md found in ${input.skillDir}`)
      }
      content = source
    }

    if (!/^---[\s\S]*?---/.test(content.trim())) {
      // Add minimal frontmatter so the loader can parse the skill.
      const name = skillNameFor(slug)
      content =
        `---\nname: ${name}\ndescription: ${readSkillDescription(content) || 'A repo-distilled skill.'}\n---\n\n` +
        content
    }

    const targetDir = registeredSkillDir(slug)
    const targetName = skillNameFor(slug)
    await ensureDir(targetDir)
    await writeFile(join(targetDir, 'SKILL.md'), content, { encoding: 'utf-8' })

    // Copy references/ and scripts/ alongside if a source directory supplied them.
    if (input.skillDir && input.skillDir !== targetDir) {
      for (const sub of ['references', 'scripts']) {
        const src = join(input.skillDir!, sub)
        if (await fileExists(src)) {
          const dst = join(targetDir, sub)
          const result = await runCommand(['cp', '-r', src, dst], {
            signal,
            timeoutMs: 60_000,
          })
          if (result.exitCode !== 0) {
            return failure('register', `failed copying ${sub}: ${result.stderr.trim()}`)
          }
        }
      }
    }

    // Hot-load: addSkillDirectories expects a *container* of skill dirs.
    await addSkillDirectories([skillStoreDir()])

    return {
      data: {
        success: true,
        action: 'register',
        message: [
          `Registered skill "${targetName}" at ${targetDir}`,
          'It is available via the Skill tool this session and auto-discovered in future sessions.',
        ].join('\n'),
        slug,
        skillName: targetName,
        skillPath: targetDir,
      },
    }
  } catch (error) {
    return failure(
      'register',
      error instanceof Error ? error.message : String(error),
    )
  }
}

async function runList(signal: AbortSignal): Promise<{ data: Output }> {
  try {
    const store = skillStoreDir()
    const entries = await readdir(store).catch(() => [] as string[])
    const skills = (
      await Promise.all(
        entries
          .filter(e => e.startsWith('repo-to-skill-'))
          .map(async e => {
            const dir = join(store, e)
            const content = await readHead(join(dir, 'SKILL.md'), 4000)
            if (!content) return null
            return {
              name: e,
              slug: e.replace(/^repo-to-skill-/, ''),
              description: readSkillDescription(content),
            }
          }),
      )
    ).filter((s): s is NonNullable<typeof s> => s !== null)

    return {
      data: {
        success: true,
        action: 'list',
        message:
          skills.length === 0
            ? 'No repo-skills registered yet.'
            : `${skills.length} repo-skill(s) registered:\n` +
              skills.map(s => `- ${s.name}: ${s.description}`).join('\n'),
        skills,
      },
    }
  } catch (error) {
    return failure(
      'list',
      error instanceof Error ? error.message : String(error),
    )
  }
}
