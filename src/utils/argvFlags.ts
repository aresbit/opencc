/**
 * Reading a boolean flag off argv the way the CLI parser would.
 *
 * Several gates need to know whether a flag was passed before (or without) a
 * commander parse, so they scan `process.argv` directly. A raw
 * `argv.includes('--flag')` disagrees with commander on one point that matters:
 * `--` is the conventional end-of-options marker, so `claude -- --flag` asks
 * for a positional argument named `--flag`, not for the flag. Commander reads
 * it that way; a raw `includes` silently turns the feature on.
 *
 * This is the one place that rule lives, so the pre-parse answer and the
 * parsed answer cannot drift apart per call site.
 */

export function scanArgvForFlag(
  flag: string,
  argv: readonly string[] = process.argv,
): boolean {
  for (const argument of argv.slice(2)) {
    // Everything past `--` is a positional argument, never a flag.
    if (argument === '--') return false
    if (argument === flag) return true
  }
  return false
}
