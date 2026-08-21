/**
 * Registers the default skill marketplace — the skill repos published by a
 * GitHub account (see DEFAULT_SKILL_MARKETPLACE_OWNER) — so /plugin can install
 * from it out of the box.
 *
 * Runs on first open of /plugin rather than at CLI startup: it costs a GitHub
 * API round trip, and a user who never opens /plugin should never pay for it.
 *
 * Registration is once-per-owner, persisted in the global config. If the user
 * later removes the marketplace we do NOT put it back — an explicit removal
 * outranks a default.
 */

import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { errorMessage } from '../errors.js'
import {
  DEFAULT_SKILL_MARKETPLACE_NAME,
  DEFAULT_SKILL_MARKETPLACE_OWNER,
} from './githubUserMarketplace.js'
import { isSourceAllowedByPolicy } from './marketplaceHelpers.js'
import {
  addMarketplaceSource,
  loadKnownMarketplacesConfigSafe,
} from './marketplaceManager.js'
import type { MarketplaceSource } from './schemas.js'

export type DefaultSkillMarketplaceResult =
  | { status: 'registered'; name: string; owner: string }
  | { status: 'skipped'; reason: DefaultSkillMarketplaceSkipReason }
  | { status: 'failed'; error: string }

export type DefaultSkillMarketplaceSkipReason =
  | 'disabled'
  | 'already_registered'
  | 'already_present'
  | 'policy_blocked'

export const DEFAULT_SKILL_MARKETPLACE_SOURCE = {
  source: 'github-user',
  owner: DEFAULT_SKILL_MARKETPLACE_OWNER,
  name: DEFAULT_SKILL_MARKETPLACE_NAME,
} as const satisfies MarketplaceSource

/** CLAUDE_CODE_DISABLE_DEFAULT_SKILL_MARKETPLACE=1 opts out entirely. */
export function isDefaultSkillMarketplaceDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_DEFAULT_SKILL_MARKETPLACE)
}

function hasRegisteredBefore(owner: string): boolean {
  return getGlobalConfig().defaultSkillMarketplaceRegistered?.[owner] === true
}

/**
 * Whether registration already happened (or was deliberately skipped) for the
 * default owner. Lets the UI decide whether to show first-run progress text —
 * it says nothing about whether the marketplace is currently installed.
 */
export function hasRegisteredDefaultSkillMarketplace(): boolean {
  return (
    isDefaultSkillMarketplaceDisabled() ||
    hasRegisteredBefore(DEFAULT_SKILL_MARKETPLACE_OWNER)
  )
}

function markRegistered(owner: string): void {
  saveGlobalConfig(current => ({
    ...current,
    defaultSkillMarketplaceRegistered: {
      ...current.defaultSkillMarketplaceRegistered,
      [owner]: true,
    },
  }))
}

/**
 * Register the default skill marketplace if it has never been registered.
 * Never throws — a failure here must not keep /plugin from opening.
 */
export async function ensureDefaultSkillMarketplace(): Promise<DefaultSkillMarketplaceResult> {
  const owner = DEFAULT_SKILL_MARKETPLACE_OWNER

  if (isDefaultSkillMarketplaceDisabled()) {
    return { status: 'skipped', reason: 'disabled' }
  }

  // Once per owner: a user who removed it gets to keep it removed.
  if (hasRegisteredBefore(owner)) {
    return { status: 'skipped', reason: 'already_registered' }
  }

  if (!isSourceAllowedByPolicy(DEFAULT_SKILL_MARKETPLACE_SOURCE)) {
    // Persist so we stop asking — enterprise policy is not going to change
    // between two /plugin opens.
    markRegistered(owner)
    return { status: 'skipped', reason: 'policy_blocked' }
  }

  // Someone (the user, a seed, settings) already brought this name in.
  const known = await loadKnownMarketplacesConfigSafe()
  if (known[DEFAULT_SKILL_MARKETPLACE_NAME]) {
    markRegistered(owner)
    return { status: 'skipped', reason: 'already_present' }
  }

  try {
    const { name } = await addMarketplaceSource(DEFAULT_SKILL_MARKETPLACE_SOURCE)
    markRegistered(owner)
    logForDebugging(`Registered default skill marketplace '${name}'`)
    return { status: 'registered', name, owner }
  } catch (error) {
    // Not marked as registered: offline now, retry next time /plugin opens.
    const message = errorMessage(error)
    logForDebugging(
      `Failed to register default skill marketplace '${owner}': ${message}`,
      { level: 'warn' },
    )
    return { status: 'failed', error: message }
  }
}
