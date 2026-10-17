"""Build public Cloudflare assets without including repository or server files."""

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SAFETY_FILES = ("factory-emergency-plan.md", "french-sources.md")


def prepare(root=ROOT):
    root = Path(root)
    frontend = root / "frontend"
    files = list(frontend.rglob("*"))
    if not (frontend / "index.html").is_file():
        raise ValueError("Missing frontend/index.html")
    for path in files:
        if path.is_symlink() or any(
            part.startswith(".") for part in path.relative_to(frontend).parts
        ):
            raise ValueError(f"Private file or symlink in public assets: {path.name}")
        if path.is_file() and path.stat().st_size > 25 * 1024 * 1024:
            raise ValueError(f"Asset exceeds Cloudflare's per-file limit: {path.name}")
    for name in SAFETY_FILES:
        path = root / "docs" / "safety" / name
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Missing regular safety document: {name}")
    output = root / ".cloudflare" / "assets"
    if output.is_symlink() or output.parent.is_symlink():
        raise ValueError("The asset build directory must not be a symlink")
    if output.exists():
        shutil.rmtree(output)
    shutil.copytree(frontend, output)
    (output / "safety").mkdir()
    for name in SAFETY_FILES:
        shutil.copy2(root / "docs" / "safety" / name, output / "safety" / name)
    (output / "_headers").write_text(
        "/*\n"
        "  Cache-Control: no-cache\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: strict-origin-when-cross-origin\n"
    )
    return output


if __name__ == "__main__":
    output = prepare()
    print(f"Public assets ready: {output}")
