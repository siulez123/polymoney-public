import json
from pathlib import Path
import tempfile
import unittest

from export_public import export_public


class PublicExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "repo"
        self.root.mkdir()
        self.output = Path(self.temp.name) / "public"
        (self.root / "example.txt").write_text("public")

    def manifest(self, entries):
        (self.root / "public-release-manifest.json").write_text(json.dumps(entries))

    def test_only_named_files_without_history_or_private_data(self):
        (self.root / ".env").write_text("PRIVATE_KEY=private")
        (self.root / ".git").mkdir()
        (self.root / "backtesting").mkdir()
        (self.root / "backtesting" / "trades.json").write_text("private")
        self.manifest({"README.md": "example.txt"})
        export_public(self.root, self.output)
        self.assertEqual([p.name for p in self.output.iterdir()], ["README.md"])

    def test_rejects_private_paths_and_traversal(self):
        for path in ["../escape", "/absolute", ".git/config", "backtesting/trades.json", ".env", "data/pnl.json", "key.pem", ".github/workflows/deploy.yml", "config.yaml"]:
            with self.subTest(path=path):
                self.manifest({"README.md": path})
                with self.assertRaises(ValueError):
                    export_public(self.root, self.output)
                self.assertFalse(self.output.exists())

    def test_rejects_symlink_and_symlink_parent(self):
        (self.root / "link.txt").symlink_to(self.root / "example.txt")
        (self.root / "linked").symlink_to(self.root, target_is_directory=True)
        for path in ["link.txt", "linked/example.txt"]:
            self.manifest({"README.md": path})
            with self.assertRaises(ValueError):
                export_public(self.root, self.output)

    def test_existing_output_is_not_overwritten(self):
        self.output.mkdir()
        (self.output / "keep").write_text("keep")
        self.manifest({"README.md": "example.txt"})
        with self.assertRaises(ValueError):
            export_public(self.root, self.output)
        self.assertEqual((self.output / "keep").read_text(), "keep")

    def test_example_maps_to_default_config(self):
        (self.root / "config.yaml").write_text("private operational config")
        (self.root / "config.example.yaml").write_text("mode: paper")
        self.manifest({"config.yaml": "config.example.yaml"})
        export_public(self.root, self.output)
        self.assertEqual((self.output / "config.yaml").read_text(), "mode: paper")


if __name__ == "__main__":
    unittest.main()
