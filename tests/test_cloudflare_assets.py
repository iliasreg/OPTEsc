"""Only public application files belong in the Cloudflare asset bundle."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    "cloudflare_assets", ROOT / "tools" / "prepare_cloudflare.py"
)
assert spec is not None and spec.loader is not None
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class CloudflareAssetsTests(unittest.TestCase):
    def fixture(self, root):
        (root / "frontend").mkdir()
        (root / "frontend" / "index.html").write_text("<title>OPTEsc</title>")
        safety = root / "docs" / "safety"
        safety.mkdir(parents=True)
        for name in assets.SAFETY_FILES:
            (safety / name).write_text("Public source notes")

    def test_bundle_contains_app_and_safety_but_not_repository_credentials(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            (root / ".cloudflare.env").write_text("PRIVATE")
            (root / "tools").mkdir()
            (root / "tools" / "private.py").write_text("PRIVATE")
            output = assets.prepare(root)
            self.assertTrue((output / "index.html").is_file())
            self.assertTrue((output / "safety" / assets.SAFETY_FILES[0]).is_file())
            self.assertFalse((output / ".cloudflare.env").exists())
            self.assertFalse((output / "tools").exists())
            (output / "stale.txt").write_text("OLD")
            assets.prepare(root)
            self.assertFalse((output / "stale.txt").exists())

    def test_symlinks_and_hidden_frontend_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.fixture(root)
            secret = root / "secret.txt"
            secret.write_text("PRIVATE")
            link = root / "frontend" / "leak.txt"
            link.symlink_to(secret)
            with self.assertRaises(ValueError):
                assets.prepare(root)
            link.unlink()
            (root / "frontend" / ".env").write_text("PRIVATE")
            with self.assertRaises(ValueError):
                assets.prepare(root)


if __name__ == "__main__":
    unittest.main()
