#!/usr/bin/env python3
"""Check or bump the release version in every version file.

Usage:
    version.py check           Print the version, or fail if files disagree.
    version.py bump [X.Y.Z]    Set every file to X.Y.Z (default: next patch).
"""

import json
import re
import sys
from pathlib import Path

PYPROJECT_VERSION = re.compile(r'(?m)^version = "([^"]+)"')
SEMVER = re.compile(r"\d+\.\d+\.\d+")

# (file, JSON key path). An empty key path means pyproject.toml's regex.
VERSION_FILES = [
    ("pyproject.toml", ()),
    ("package.json", ("version",)),
    ("package-lock.json", ("version",)),
    ("package-lock.json", ("packages", "", "version")),
    ("opencode-plugin/package.json", ("version",)),
    ("pi-extension/package.json", ("version",)),
    (".codex-plugin/plugin.json", ("version",)),
    (".claude-plugin/plugin.json", ("version",)),
    (".claude-plugin/marketplace.json", ("plugins", 0, "version")),
]


def label(path, keys):
    if len(keys) <= 1:
        return path
    return f"{path} {''.join(f'[{json.dumps(key)}]' for key in keys)}"


def read_versions():
    versions = {}
    for path, keys in VERSION_FILES:
        text = Path(path).read_text()
        if not keys:
            versions[label(path, keys)] = PYPROJECT_VERSION.search(text).group(1)
            continue
        node = json.loads(text)
        for key in keys:
            node = node[key]
        versions[label(path, keys)] = node
    return versions


def check():
    versions = read_versions()
    if len(set(versions.values())) != 1:
        lines = "\n".join(f"  {name}: {version}" for name, version in versions.items())
        sys.exit(f"Version drift:\n{lines}")
    return next(iter(versions.values()))


def write_version(version):
    keys_by_file = {}
    for path, keys in VERSION_FILES:
        keys_by_file.setdefault(path, []).append(keys)
    for path, key_paths in keys_by_file.items():
        file = Path(path)
        text = file.read_text()
        if path == "pyproject.toml":
            file.write_text(PYPROJECT_VERSION.sub(f'version = "{version}"', text, count=1))
            continue
        data = json.loads(text)
        for keys in key_paths:
            node = data
            for key in keys[:-1]:
                node = node[key]
            node[keys[-1]] = version
        file.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def bump(version=None):
    current = check()
    if not version:
        major, minor, patch = map(int, current.split("."))
        version = f"{major}.{minor}.{patch + 1}"
    if not SEMVER.fullmatch(version):
        sys.exit(f"Version must be X.Y.Z: {version!r}")
    write_version(version)
    return version


def main(argv):
    if argv[:1] == ["check"] and len(argv) == 1:
        print(check())
    elif argv[:1] == ["bump"] and len(argv) <= 2:
        print(bump(*argv[1:]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
