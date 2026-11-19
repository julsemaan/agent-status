import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tools"))

import version  # noqa: E402

FILES = sorted({path for path, _ in version.VERSION_FILES})


class VersionToolTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for path in FILES + ["tools/version.py"]:
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(REPO / path, self.root / path)

    def run_tool(self, *args):
        return subprocess.run(
            [sys.executable, "tools/version.py", *args],
            cwd=self.root, capture_output=True, text=True,
        )

    def read_json(self, path):
        return json.loads((self.root / path).read_text())

    def versions(self):
        lock = self.read_json("package-lock.json")
        return [
            re.search(r'(?m)^version = "([^"]+)"', (self.root / "pyproject.toml").read_text())[1],
            self.read_json("package.json")["version"],
            lock["version"],
            lock["packages"][""]["version"],
            self.read_json("opencode-plugin/package.json")["version"],
            self.read_json("pi-extension/package.json")["version"],
            self.read_json(".codex-plugin/plugin.json")["version"],
            self.read_json(".claude-plugin/plugin.json")["version"],
            self.read_json(".claude-plugin/marketplace.json")["plugins"][0]["version"],
        ]

    def current(self):
        return self.run_tool("check").stdout.strip()

    def test_default_bump_increments_patch_everywhere(self):
        major, minor, patch = map(int, self.current().split("."))
        expected = f"{major}.{minor}.{patch + 1}"

        result = self.run_tool("bump")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), expected)
        self.assertEqual(set(self.versions()), {expected})
        self.assertEqual(self.current(), expected)

    def test_explicit_version_sets_every_file(self):
        result = self.run_tool("bump", "2.4.6")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.versions()), {"2.4.6"})

    def test_invalid_version_fails(self):
        before = self.versions()

        result = self.run_tool("bump", "bad")

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.versions(), before)

    def test_check_reports_drifting_file(self):
        manifest = self.root / ".claude-plugin/plugin.json"
        data = json.loads(manifest.read_text())
        data["version"] = "9.9.9"
        manifest.write_text(json.dumps(data, indent=2) + "\n")

        result = self.run_tool("check")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(".claude-plugin/plugin.json: 9.9.9", result.stderr)


if __name__ == "__main__":
    unittest.main()
