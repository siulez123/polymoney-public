#!/usr/bin/env python3
"""Export an explicit source manifest, without Git history or operational data."""
import argparse
import json
from pathlib import Path, PurePosixPath
import shutil
import tempfile


def safe_path(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("invalid manifest path")
    p = PurePosixPath(value)
    if p.is_absolute() or any(part in ("..", ".git", "backtesting", "data", "node_modules") for part in p.parts):
        raise ValueError("private or unsafe manifest path")
    if p.name.startswith(".env") and str(p) != ".env.example":
        raise ValueError("environment secrets cannot be exported")
    if p.suffix in (".pem", ".key", ".log", ".gz", ".sqlite", ".db"):
        raise ValueError("private file type")
    if str(p).startswith(".github/workflows/") and str(p) != ".github/workflows/ci.yml":
        raise ValueError("only CI may be exported")
    return p


def export_public(root, output):
    root = Path(root).resolve()
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("output must not exist")
    if not output.parent.is_dir():
        raise ValueError("output parent must exist")
    manifest = json.loads((root / "public-release-manifest.json").read_text())
    if not isinstance(manifest, dict) or not manifest:
        raise ValueError("manifest must be a nonempty mapping")
    checked = []
    for destination, source in manifest.items():
        dst, src = safe_path(destination), safe_path(source)
        if source == "config.yaml":
            raise ValueError("operational config must not be exported")
        current = root
        for part in src.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError("symlinks cannot be exported")
        if not current.is_file():
            raise ValueError("manifest source missing: " + source)
        checked.append((dst, current))
    # Stage outside the source tree; validation failure leaves no partial export.
    with tempfile.TemporaryDirectory(prefix="polymoney-export-", dir=output.parent) as staging:
        stage = Path(staging) / "source"
        stage.mkdir()
        for dst, src in checked:
            target = stage / dst
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, target)
        # mkdir is exclusive, including under competing export processes.
        output.mkdir()
        try:
            for child in stage.iterdir():
                shutil.move(str(child), output / child.name)
        except Exception:
            shutil.rmtree(output)
            raise
    return len(checked)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    count = export_public(Path(__file__).resolve().parents[1], args.output)
    print(f"Exported {count} files. Review contents, secrets and licensing before publication.")


if __name__ == "__main__":
    main()
