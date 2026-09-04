/**
 * Substructural pattern matcher.
 *
 * An object matches when each of its keys matches recursively.
 * An array matches when ANY of its elements matches (disjunction).
 * Any other value matches by strict equality.
 * An empty array matches nothing.
 */

export function matchesSubstructural(
  matcher: unknown,
  value: unknown,
): boolean {
  if (matcher === undefined || matcher === null) return true

  if (Array.isArray(matcher)) {
    if (matcher.length === 0) return false
    return matcher.some(m => matchesSubstructural(m, value))
  }

  if (typeof matcher === 'object' && matcher !== null) {
    if (typeof value !== 'object' || value === null) return false
    const obj = value as Record<string, unknown>
    for (const [k, v] of Object.entries(matcher)) {
      if (!matchesSubstructural(v, obj[k])) return false
    }
    return true
  }

  return matcher === value
}
