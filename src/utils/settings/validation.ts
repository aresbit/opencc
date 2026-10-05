import type { ConfigScope } from 'src/services/mcp/types.js'
import { HOOK_EVENTS } from 'src/entrypoints/agentSdkTypes.js'
import type { ZodError, ZodIssue } from 'zod/v4'
import { HookCommandSchema, HookMatcherSchema } from '../../schemas/hooks.js'
import { jsonParse } from '../slowOperations.js'
import { plural } from '../stringUtils.js'
import { validatePermissionRule } from './permissionValidation.js'
import { generateSettingsJSONSchema } from './schemaOutput.js'
import type { SettingsJson } from './types.js'
import { SettingsSchema } from './types.js'
import { getValidationTip } from './validationTips.js'

/**
 * Helper type guards for specific Zod v4 issue types
 * In v4, issue types have different structures than v3
 */
function isInvalidTypeIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'invalid_type'
  expected: string
  input: unknown
} {
  return issue.code === 'invalid_type'
}

function isInvalidValueIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'invalid_value'
  values: unknown[]
  input: unknown
} {
  return issue.code === 'invalid_value'
}

function isUnrecognizedKeysIssue(
  issue: ZodIssue,
): issue is ZodIssue & { code: 'unrecognized_keys'; keys: string[] } {
  return issue.code === 'unrecognized_keys'
}

function isTooSmallIssue(issue: ZodIssue): issue is ZodIssue & {
  code: 'too_small'
  minimum: number | bigint
  origin: string
} {
  return issue.code === 'too_small'
}

/** Field path in dot notation (e.g., "permissions.defaultMode", "env.DEBUG") */
export type FieldPath = string

export type ValidationError = {
  /** Relative file path */
  file?: string
  /** Field path in dot notation */
  path: FieldPath
  /** Human-readable error message */
  message: string
  /** Expected value or type */
  expected?: string
  /** The actual invalid value that was provided */
  invalidValue?: unknown
  /** Suggestion for fixing the error */
  suggestion?: string
  /** Link to relevant documentation */
  docLink?: string
  /** MCP-specific metadata - only present for MCP configuration errors */
  mcpErrorMetadata?: {
    /** Which configuration scope this error came from */
    scope: ConfigScope
    /** The server name if error is specific to a server */
    serverName?: string
    /** Severity of the error */
    severity?: 'fatal' | 'warning'
  }
}

export type SettingsWithErrors = {
  settings: SettingsJson
  errors: ValidationError[]
}

/**
 * Format a Zod validation error into human-readable validation errors
 */
/**
 * Get the type string for an unknown value (for error messages)
 */
function getReceivedType(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function extractReceivedFromMessage(msg: string): string | undefined {
  const match = msg.match(/received (\w+)/)
  return match ? match[1] : undefined
}

export function formatZodError(
  error: ZodError,
  filePath: string,
): ValidationError[] {
  return error.issues.map((issue): ValidationError => {
    const path = issue.path.map(String).join('.')
    let message = issue.message
    let expected: string | undefined

    let enumValues: string[] | undefined
    let expectedValue: string | undefined
    let receivedValue: unknown
    let invalidValue: unknown

    if (isInvalidValueIssue(issue)) {
      enumValues = issue.values.map(v => String(v))
      expectedValue = enumValues.join(' | ')
      receivedValue = undefined
      invalidValue = undefined
    } else if (isInvalidTypeIssue(issue)) {
      expectedValue = issue.expected
      const receivedType = extractReceivedFromMessage(issue.message)
      receivedValue = receivedType ?? getReceivedType(issue.input)
      invalidValue = receivedType ?? getReceivedType(issue.input)
    } else if (isTooSmallIssue(issue)) {
      expectedValue = String(issue.minimum)
    } else if (issue.code === 'custom' && 'params' in issue) {
      const params = issue.params as { received?: unknown }
      receivedValue = params.received
      invalidValue = receivedValue
    }

    const tip = getValidationTip({
      path,
      code: issue.code,
      expected: expectedValue,
      received: receivedValue,
      enumValues,
      message: issue.message,
      value: receivedValue,
    })

    if (isInvalidValueIssue(issue)) {
      expected = enumValues?.map(v => `"${v}"`).join(', ')
      message = `Invalid value. Expected one of: ${expected}`
    } else if (isInvalidTypeIssue(issue)) {
      const receivedType =
        extractReceivedFromMessage(issue.message) ??
        getReceivedType(issue.input)
      if (
        issue.expected === 'object' &&
        receivedType === 'null' &&
        path === ''
      ) {
        message = 'Invalid or malformed JSON'
      } else {
        message = `Expected ${issue.expected}, but received ${receivedType}`
      }
    } else if (isUnrecognizedKeysIssue(issue)) {
      const keys = issue.keys.join(', ')
      message = `Unrecognized ${plural(issue.keys.length, 'field')}: ${keys}`
    } else if (isTooSmallIssue(issue)) {
      message = `Number must be greater than or equal to ${issue.minimum}`
      expected = String(issue.minimum)
    }

    return {
      file: filePath,
      path,
      message,
      expected,
      invalidValue,
      suggestion: tip?.suggestion,
      docLink: tip?.docLink,
    }
  })
}

/**
 * Validates that settings file content conforms to the SettingsSchema.
 * This is used during file edits to ensure the resulting file is valid.
 */
export function validateSettingsFileContent(content: string):
  | {
      isValid: true
    }
  | {
      isValid: false
      error: string
      fullSchema: string
    } {
  try {
    // Parse the JSON first
    const jsonData = jsonParse(content)

    // Validate against SettingsSchema in strict mode
    const result = SettingsSchema().strict().safeParse(jsonData)

    if (result.success) {
      return { isValid: true }
    }

    // Format the validation error in a helpful way
    const errors = formatZodError(result.error, 'settings')
    const errorMessage =
      'Settings validation failed:\n' +
      errors.map(err => `- ${err.path}: ${err.message}`).join('\n')

    return {
      isValid: false,
      error: errorMessage,
      fullSchema: generateSettingsJSONSchema(),
    }
  } catch (parseError) {
    return {
      isValid: false,
      error: `Invalid JSON: ${parseError instanceof Error ? parseError.message : 'Unknown parsing error'}`,
      fullSchema: generateSettingsJSONSchema(),
    }
  }
}

/**
 * Filters invalid permission rules from raw parsed JSON data before schema validation.
 * This prevents one bad rule from poisoning the entire settings file.
 * Returns warnings for each filtered rule.
 */
export function filterInvalidPermissionRules(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  if (!obj.permissions || typeof obj.permissions !== 'object') return []
  const perms = obj.permissions as Record<string, unknown>

  const warnings: ValidationError[] = []
  for (const key of ['allow', 'deny', 'ask']) {
    const rules = perms[key]
    if (!Array.isArray(rules)) continue

    perms[key] = rules.filter(rule => {
      if (typeof rule !== 'string') {
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message: `Non-string value in ${key} array was removed`,
          invalidValue: rule,
        })
        return false
      }
      const result = validatePermissionRule(rule)
      if (!result.valid) {
        let message = `Invalid permission rule "${rule}" was skipped`
        if (result.error) message += `: ${result.error}`
        if (result.suggestion) message += `. ${result.suggestion}`
        warnings.push({
          file: filePath,
          path: `permissions.${key}`,
          message,
          invalidValue: rule,
        })
        return false
      }
      return true
    })
  }
  return warnings
}

/**
 * Filters unusable hooks from raw parsed JSON before schema validation.
 *
 * This is the same hazard `filterInvalidPermissionRules` guards against for
 * permissions, but for hooks — and for hooks it is worse. `parseSettingsFile`
 * returns `settings: null` whenever the whole settings object fails
 * `SettingsSchema`, which discards the file's `env` block too. When `env` holds
 * ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL (the usual way a third-party provider
 * is wired up), a single hook the build doesn't understand silently logs every
 * session out — "Not logged in" with no hint of the cause.
 *
 * Removes, with a warning for each: a `hooks` value that isn't an object,
 * event keys not in HOOK_EVENTS, non-array matcher lists, non-object matchers,
 * hook entries whose `type` isn't one of command/prompt/agent/http/mcp_tool,
 * and any matcher that still fails validation afterwards. The returned
 * warnings are surfaced next to the file so the removal isn't silent.
 */
export function filterInvalidHooks(
  data: unknown,
  filePath: string,
): ValidationError[] {
  if (!data || typeof data !== 'object') return []
  const obj = data as Record<string, unknown>
  if (obj.hooks === undefined) return []

  const warnings: ValidationError[] = []

  if (
    obj.hooks === null ||
    typeof obj.hooks !== 'object' ||
    Array.isArray(obj.hooks)
  ) {
    warnings.push({
      file: filePath,
      path: 'hooks',
      message:
        'Malformed `hooks` (expected an object keyed by event name) was removed',
      invalidValue: obj.hooks,
    })
    delete obj.hooks
    return warnings
  }

  const hooks = obj.hooks as Record<string, unknown>
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      warnings.push({
        file: filePath,
        path: `hooks.${event}`,
        message: `Unknown hook event "${event}" was removed (valid events: ${HOOK_EVENTS.join(', ')})`,
        invalidValue: matchers,
      })
      delete hooks[event]
      continue
    }

    if (!Array.isArray(matchers)) {
      warnings.push({
        file: filePath,
        path: `hooks.${event}`,
        message: `hooks.${event} must be an array of matchers; it was removed`,
        invalidValue: matchers,
      })
      delete hooks[event]
      continue
    }

    const kept: unknown[] = []
    for (const matcher of matchers) {
      if (!matcher || typeof matcher !== 'object') {
        warnings.push({
          file: filePath,
          path: `hooks.${event}`,
          message: 'Non-object hook matcher was removed',
          invalidValue: matcher,
        })
        continue
      }
      const entry = matcher as Record<string, unknown>
      if (Array.isArray(entry.hooks)) {
        entry.hooks = entry.hooks.filter(hook => {
          if (HookCommandSchema().safeParse(hook).success) return true
          const type =
            hook && typeof hook === 'object' && 'type' in hook
              ? (hook as Record<string, unknown>).type
              : undefined
          warnings.push({
            file: filePath,
            path: `hooks.${event}`,
            message:
              `Hook with unsupported type ${JSON.stringify(type)} was removed ` +
              `(supported: command, prompt, agent, http, mcp_tool)`,
            invalidValue: hook,
          })
          return false
        })
      }
      if (HookMatcherSchema().safeParse(entry).success) {
        kept.push(entry)
      } else {
        warnings.push({
          file: filePath,
          path: `hooks.${event}`,
          message:
            'Hook matcher failed validation after filtering and was removed',
          invalidValue: entry,
        })
      }
    }
    hooks[event] = kept
  }
  return warnings
}
