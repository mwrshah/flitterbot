#!/usr/bin/env python3
"""Single entry point for the configured learnings note.

Subcommands:
    codes              Print every code and the unique situation labels under
                       it. Use before classifying a new learning.
    add "CC-situ: x"   Append a learning. Code prefix CC is required and is
                       the sole grouping key.
    add --new "x: y"   Mint a fresh 2-char code, prepend it, and append.

The note path comes from ~/.flitterbot/config.json key `learningsNotePath`.
Set $FLITTERBOT_CONFIG to point at a different config file.

After every add the bullet list is auto-regrouped so all entries sharing
a code are contiguous (first-seen code order preserved). Codeless legacy
bullets sink to the end of the list.

Code alphabet: ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (32 chars, no 0/O/1/I).
2 chars → 1024 distinct situations.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
from collections import OrderedDict
from pathlib import Path

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_PREFIX_RE = re.compile(r"^([A-Z2-9]{2})-")
BULLET_RE = re.compile(r"^- ([A-Z2-9]{2})-([^:]+):\s*(.*)$")


def expand_home(value: str) -> Path:
    if value == "~":
        return Path.home()
    if value.startswith("~/"):
        return Path.home() / value[2:]
    return Path(value)


# ponytail: recall.py duplicates config parsing and entry parsing; share a tiny module.
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


def read_lines() -> list[str]:
    return NOTE.read_text().split("\n") if NOTE.exists() else []


def parse_entries() -> list[tuple[str, str, str]]:
    """Return [(code, situation, body), ...] in file order."""
    out: list[tuple[str, str, str]] = []
    for line in read_lines():
        m = BULLET_RE.match(line)
        if m:
            out.append((m.group(1), m.group(2).strip(), m.group(3).strip()))
    return out


def existing_codes() -> set[str]:
    return {code for code, _, _ in parse_entries()}


def extract_prefix(body: str) -> str | None:
    m = CODE_PREFIX_RE.match(body)
    return m.group(1) if m else None


def mint_code() -> str:
    used = existing_codes()
    if len(used) >= len(ALPHABET) ** 2:
        raise RuntimeError("code space exhausted (1024 codes already used)")
    for _ in range(10_000):
        code = "".join(secrets.choice(ALPHABET) for _ in range(2))
        if code not in used:
            return code
    raise RuntimeError("could not mint a fresh code (random exhaustion)")


def regroup(lines: list[str]) -> list[str]:
    """Cluster `- ` bullets by their 2-char code, preserving first-seen order.

    Bullet positions stay; only contents are permuted. Non-bullet lines
    between bullets stay in place. Codeless bullets sink to the end.
    """
    positions = [i for i, ln in enumerate(lines) if ln.startswith("- ")]
    if not positions:
        return lines

    groups: "OrderedDict[str, list[str]]" = OrderedDict()
    uncoded: list[str] = []
    for pos in positions:
        bullet = lines[pos]
        code = extract_prefix(bullet[2:].strip())
        if code is None:
            uncoded.append(bullet)
        else:
            groups.setdefault(code, []).append(bullet)

    reordered = [b for items in groups.values() for b in items] + uncoded
    for pos, bullet in zip(positions, reordered):
        lines[pos] = bullet
    return lines


def cmd_codes(_: argparse.Namespace) -> int:
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

    blocks = [
        "\n".join([code] + [f"  {s}" for s in situations.values()])
        for code, situations in groups.items()
    ]
    print("\n\n".join(blocks))
    return 0


def cmd_add(args: argparse.Namespace) -> int:
    learning = args.text.strip()
    if learning.startswith("- "):
        learning = learning[2:].strip()
    if not learning:
        print("empty learning", file=sys.stderr)
        return 2

    existing_prefix = extract_prefix(learning)

    if args.new:
        if existing_prefix is not None:
            print(
                "--new conflicts with an explicit code prefix already on the "
                "input; pass the bare 'situation: body' instead",
                file=sys.stderr,
            )
            return 2
        try:
            code = mint_code()
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 1
        learning = f"{code}-{learning}"
    else:
        if existing_prefix is None:
            print(
                "missing or invalid code prefix; expected 'CC-situation: body' "
                "where CC matches [A-Z2-9]{2}, or pass --new to mint one",
                file=sys.stderr,
            )
            return 2
        code = existing_prefix

    new_line = f"- {learning}"

    if not NOTE.exists():
        NOTE.parent.mkdir(parents=True, exist_ok=True)
        NOTE.write_text(f"---\ntags: project\n---\n\n{new_line}\n")
        print(f"created note and added: {new_line}")
        return 0

    lines = read_lines()
    positions = [i for i, ln in enumerate(lines) if ln.startswith("- ")]
    if positions:
        lines.insert(positions[-1] + 1, new_line)
    else:
        while lines and lines[-1] == "":
            lines.pop()
        lines.extend(["", new_line])

    lines = regroup(lines)
    NOTE.write_text("\n".join(lines) + ("\n" if lines[-1] != "" else ""))

    prior = sum(1 for ln in lines if ln.startswith(f"- {code}-")) - 1
    where = (
        f"joined existing '{code}' group ({prior} prior)"
        if prior > 0
        else f"new code '{code}'"
    )
    print(f"added — {where}: {new_line}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Manage the configured learnings note.")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_codes = sub.add_parser("codes", help="list codes and situation labels")
    p_codes.set_defaults(func=cmd_codes)

    p_add = sub.add_parser("add", help="append a learning")
    p_add.add_argument("text", help='"CC-situation: body" or, with --new, "situation: body"')
    p_add.add_argument("--new", action="store_true", help="mint a fresh code and prepend it")
    p_add.set_defaults(func=cmd_add)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
