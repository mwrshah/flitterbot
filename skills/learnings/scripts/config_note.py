"""Resolve the note through Flitterbot's document boundary."""

import subprocess
from pathlib import Path


def resolve_note_path() -> Path:
    root = Path(__file__).resolve().parents[3]
    access = root / "scripts" / "config-access.mjs"
    if not access.exists():
        access = root / "installer" / "scripts" / "config-access.mjs"
    result = subprocess.run(
        ["node", str(access), "read", "runtime-config", "learningsNotePath"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(
            result.stderr.strip() or "Cannot load Flitterbot configuration"
        )
    value = result.stdout.strip()
    if not value:
        raise RuntimeError("Missing required config key learningsNotePath")
    return Path(value).expanduser()
