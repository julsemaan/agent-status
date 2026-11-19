#!/usr/bin/env python3
"""Check that each npm package only ships its expected files."""

import json
import subprocess
import sys

PACKAGES = ["opencode-plugin", "pi-extension"]
EXPECTED = {"index.js", "package.json", "README.md", "LICENSE"}

failed = False
for package in PACKAGES:
    output = subprocess.run(
        ["npm", "pack", f"./{package}", "--dry-run", "--json"],
        check=True, capture_output=True, text=True,
    ).stdout
    files = {entry["path"] for entry in json.loads(output)[0]["files"]}
    if files == EXPECTED:
        print(f"{package}: package files match")
    else:
        print(f"{package}: unexpected package files {sorted(files)}", file=sys.stderr)
        failed = True

sys.exit(failed)
