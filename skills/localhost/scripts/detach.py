#!/usr/bin/env python3
import os
import sys

if len(sys.argv) < 3:
    raise SystemExit("usage: detach.py <cwd> <command> [args...]")

os.chdir(sys.argv[1])
os.setsid()
os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
