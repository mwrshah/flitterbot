#!/usr/bin/env python3
"""Recall learnings from the configured learnings note.

Subcommands:
    list           Print every code and the unique situation labels under it.
    show CC        Print every learning entry under code CC.

The note path comes from the durable runtime configuration key `learningsNotePath`.

Only lines matching `- CC-situation: body` (with `CC` from [A-Z2-9]{2})
are considered. Codeless bullets are ignored.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections import OrderedDict
from config_note import resolve_note_path

BULLET_RE = re.compile(r"^- ([A-Z2-9]{2})-([^:]+):\s*(.*)$")


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
    all_entries = parse_entries()
    status = 0
    for index, raw_code in enumerate([args.code, *args.extra_codes]):
        if index:
            print()
        code = raw_code.upper()
        entries = [entry for entry in all_entries if entry[0] == code]
        if not entries:
            print(f"(no entries for code '{code}')")
            status = 1
            continue
        print(code)
        for _, situation, body in entries:
            print(f"  - {situation}: {body}")
    return status


def main() -> int:
    p = argparse.ArgumentParser(description="Recall learnings.")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="list codes and situation labels")
    p_list.set_defaults(func=cmd_list)

    p_show = sub.add_parser("show", help="show all entries under one code")
    p_show.add_argument("code", help="2-char code, e.g. LB")
    p_show.add_argument("extra_codes", nargs="*", help=argparse.SUPPRESS)
    p_show.set_defaults(func=cmd_show)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
