"""R00: frozen Unicode recovery and historical-run invalidation.

Asserts against the real project checkout (JAVA_LSP_PROJECT or $PROJECT) and the
frozen recovery source in baseline-kit/. Without a project checkout the project
asserts are skipped (BLOCKED_ENV), never faked.
"""
import hashlib
import json
import os
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE_REL = "dataset/contracts/fixtures/unicode/src/main/java/demo/Unicode.java"
GOOD = "294cd139daf877efe01a66a81da59ca3ec652806837da749eb60486eb0dd43b3"
BAD = "42f1c89bcc4ced94b42e738de6f536104b13be8a809645ccbd6611cdc5aa681b"
MANIFEST_SHA = "6233410947b1a4bbe1860789856f7789af7cf29e6092d4de5143f7202227b223"

def _project_root():
    for var in ("JAVA_LSP_PROJECT", "PROJECT"):
        value = os.environ.get(var)
        if value and (Path(value) / "package.json").exists():
            return Path(value).resolve()
    # Default layout when the package lives inside the project checkout.
    candidate = ROOT.parent
    if (candidate / "package.json").exists() and candidate.name == "docs" or (ROOT / "package.json").exists():
        return ROOT if (ROOT / "package.json").exists() else candidate.parent
    return None


class R00FrozenRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.project = _project_root()
        if self.project is None:
            self.skipTest("no project checkout available (BLOCKED_ENV)")

    def test_recovery_source_is_the_frozen_original(self):
        original = (ROOT / "baseline-kit" / BASELINE_REL).read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), GOOD)
        self.assertIn(b"\r\n", original, "baseline recovery source must keep CRLF")

    def test_project_fixture_restored_to_original_bytes(self):
        fixture = self.project / "docs/java-specialist-devkit-v1" / BASELINE_REL
        current_bytes = fixture.read_bytes()
        current = hashlib.sha256(current_bytes).hexdigest()
        self.assertEqual(current, GOOD, "fixture must be the exact frozen CRLF bytes, not LF-normalized drift")
        self.assertNotEqual(current, BAD)

    def test_frozen_manifest_unchanged(self):
        manifest = self.project / "docs/java-specialist-devkit-v1/dataset/manifest.json"
        self.assertEqual(hashlib.sha256(manifest.read_bytes()).hexdigest(), MANIFEST_SHA,
                         "R00 must never refresh the frozen manifest to accept bad bytes")

    def test_gitattributes_pins_exact_path(self):
        attrs = self.project / ".gitattributes"
        self.assertTrue(attrs.exists(), "root .gitattributes is required so git stops re-normalizing the fixture")
        lines = attrs.read_text(encoding="utf-8").splitlines()
        rule = "docs/java-specialist-devkit-v1/dataset/contracts/fixtures/unicode/src/main/java/demo/Unicode.java -text"
        self.assertIn(rule, lines, "the -text rule must target the exact fixture path, not mass normalize")

    def test_invalidated_runs_registry_marks_every_run_ineligible(self):
        registry = json.loads((ROOT.parent / "next-stage" / "invalidated-runs.json").read_text(encoding="utf-8"))
        self.assertTrue(registry["runs"], "the invalidated-run registry must not be empty")
        for row in registry["runs"]:
            self.assertEqual(row["status"], "INVALID_EXPERIMENT")
            self.assertIs(row["causalClaimEligible"], False,
                          f"{row.get('run')} may not support causal capability claims")


if __name__ == "__main__":
    unittest.main()