#!/usr/bin/env python3
"""Generate the TypeScript Imagine prompt asset from the Python source of truth.

The Python module ``backend/src/autoagent_backend/domain/imagine_prompt.py``
owns the Imagine prompt text and its module router.  The OpenCC tools need the
same text at runtime, so this script serializes it into a checked-in TypeScript
module instead of letting anyone hand-copy it.

Usage:
    python3 scripts/generate-imagine-assets.py          # write the asset
    python3 scripts/generate-imagine-assets.py --stdout # print it (drift test)

The script imports the Python module by file path, so it does not require the
backend package to be installed.  The emitted file records the SHA-256 of the
Python source.  ``src/tools/ReadMeTool/__tests__/readMe.test.ts`` always
recomputes that hash, and additionally regenerates the asset and compares it
byte-for-byte when ``python3`` is available.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

SCRIPT_DIR = Path(__file__).resolve().parent
OPENCC_ROOT = SCRIPT_DIR.parent
REPO_ROOT = OPENCC_ROOT.parents[1]
SOURCE_REL = "backend/src/autoagent_backend/domain/imagine_prompt.py"
SOURCE_PATH = REPO_ROOT / SOURCE_REL
OUTPUT_PATH = OPENCC_ROOT / "src/tools/ReadMeTool/imagine_prompt.generated.ts"


def load_source() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "opencc_imagine_prompt_source", SOURCE_PATH
    )
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {SOURCE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def q(value: str) -> str:
    """Return a JavaScript/TypeScript string literal."""

    return json.dumps(value, ensure_ascii=False)


def render(module: ModuleType, source_sha: str) -> str:
    base = q(module.IMAGINE_BASE_PROMPT)

    sections = "\n".join(
        f"  {name}: {q(module.IMAGINE_SECTION_PROMPTS[name])},"
        for name in module.IMAGINE_SECTION_ORDER
    )

    section_order = "\n".join(
        f"  {q(name)}," for name in module.IMAGINE_SECTION_ORDER
    )

    routes = "\n".join(
        "  {}: [{}],".format(
            q(name),
            ", ".join(q(section) for section in module.IMAGINE_MODULE_ROUTES[name]),
        )
        for name in module.IMAGINE_MODULE_NAMES
    )

    module_names = "\n".join(
        f"  {q(name)}," for name in module.IMAGINE_MODULE_NAMES
    )

    widths = "\n".join(
        f"  {q(platform)}: {width},"
        for platform, width in module.IMAGINE_PLATFORM_WIDTHS.items()
    )

    return f"""\
// AUTO-GENERATED. DO NOT EDIT BY HAND.
// Source of truth: {SOURCE_REL}
// Regenerate: python3 scripts/generate-imagine-assets.py
// Source SHA-256: {source_sha}

export const IMAGINE_SOURCE_PATH = {q(SOURCE_REL)}
export const IMAGINE_SOURCE_SHA256 = {q(source_sha)}

export const IMAGINE_BASE_PROMPT = {base}

export const IMAGINE_SECTION_PROMPTS = {{
{sections}
}} as const

export const IMAGINE_SECTION_ORDER = [
{section_order}
] as const

export const IMAGINE_MODULE_ROUTES = {{
{routes}
}} as const

export const IMAGINE_MODULE_NAMES = [
{module_names}
] as const

export const IMAGINE_PLATFORM_WIDTHS = {{
{widths}
}} as const

export type ImagineSection = (typeof IMAGINE_SECTION_ORDER)[number]
export type ImagineModule = (typeof IMAGINE_MODULE_NAMES)[number]
export type ImaginePlatform = keyof typeof IMAGINE_PLATFORM_WIDTHS
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="print the generated asset instead of writing it",
    )
    args = parser.parse_args()

    if not SOURCE_PATH.is_file():
        raise SystemExit(f"missing source file: {SOURCE_PATH}")

    source_bytes = SOURCE_PATH.read_bytes()
    source_sha = hashlib.sha256(source_bytes).hexdigest()
    module = load_source()
    content = render(module, source_sha)

    if args.stdout:
        sys.stdout.write(content)
        return 0

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
