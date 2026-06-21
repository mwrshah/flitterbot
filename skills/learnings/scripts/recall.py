#!/usr/bin/env python3
"""Recall learnings from the configured learnings note.

Subcommands:
    list           Print every code and the unique situation labels under it.
    show CC        Print every learning entry under code CC.

The note path comes from ~/.flitterbot/config.json key `learningsNotePath`.
Set $FLITTERBOT_CONFIG to point at a different config file.

Only lines matching `- CC-situation: body` (with `CC` from [A-Z2-9]{2})
are considered. Codeless bullets are ignored.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import OrderedDict
from pathlib import Path

BULLET_RE = re.compile(r"^- ([A-Z2-9]{2})-([^:]+):\s*(.*)$")


def expand_home(value: str) -> Path:
    if value == "~":
        return Path.home()
    if value.startswith("~/"):
        return Path.home() / value[2:]
    return Path(value)


def resolve_note_path() -> Path:
    config_path = expand_home(os.environ.get("FLITTERBOT_CONFIG", "~/.flitterbot/config.json"))
    if not config_path.exists():
        raise RuntimeError(f"Missing Flitterbot config: {config_path}")
    try:
        raw = json.loads(config_path.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON in Flitterbot config {config_path}: {exc.msg}") from exc
    if not isinstance(raw, dict):
        raise RuntimeError(f"Invalid Flitterbot config {config_path}: expected a JSON object")
    value = raw.get("learningsNotePath")
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"Missing required config key learningsNotePath in {config_path}")
    return expand_home(value.strip())


NOTE = resolve_note_path()


def parse_entries() -> list[tuple[str, str, str]]:
    """Return [(code, situation, body), ...] in file order."""
    if not NOTE.exists():
        return []
    out: list[tuple[str, str, str]] = []
    for line in NOTE.read_text().split("\n"):
        m = BULLET_RE.match(line)
        if m:
            out.append((m.group(1), m.group(2).strip(), m.group(3).strip()))
    return out


def cmd_list(_: argparse.Namespace) -> int:
    entries = parse_entries()
    if not entries:
        print("(no learnings recorded yet)")
        return 0

    groups: "OrderedDict[str, OrderedDict[str, str]]" = OrderedDict()
    for code, situation, _ in entries:
        groups.setdefault(code, OrderedDict())
        key = situation.lower()
        if key not in groups[code]:
            groups[code][key] = situation

    blocks: list[str] = []
    for code, situations in groups.items():
        block = [code] + [f"  {s}" for s in situations.values()]
        blocks.append("\n".join(block))
    print("\n\n".join(blocks))
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    code = args.code.upper()
    entries = [e for e in parse_entries() if e[0] == code]
    if not entries:
        print(f"(no entries for code '{code}')")
        return 1
    print(code)
    for _, situation, body in entries:
        print(f"  - {situation}: {body}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Recall learnings.")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="list codes and situation labels")
    p_list.set_defaults(func=cmd_list)

    p_show = sub.add_parser("show", help="show all entries under one code")
    p_show.add_argument("code", help="2-char code, e.g. LB")
    p_show.set_defaults(func=cmd_show)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
