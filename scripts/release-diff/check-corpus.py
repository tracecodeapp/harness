#!/usr/bin/env python3
"""Bind the host's copied app corpus to the independently reviewed manifest."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys


def verify(root, app_sha, manifest):
    if not re.fullmatch(r"[0-9a-f]{40}", app_sha) or manifest.get("appDataSha") != app_sha:
        raise ValueError("release-diff/preflight/app-data-sha")
    expected = {}
    for entry in manifest.get("dataFiles", []):
        path = PurePosixPath(entry["path"])
        if path.is_absolute() or ".." in path.parts or str(path) != entry["path"] or path in expected:
            raise ValueError(f"release-diff/preflight/data-path/{path}")
        expected[path] = entry["sha256"]
    roots = ("problems", "reference-solutions", "interviews", "interview-reference-solutions", "interview-private")
    observed = {}
    for relative in roots:
        tree = root / relative
        if not tree.is_dir() or tree.is_symlink():
            raise ValueError(f"release-diff/preflight/missing-data/{relative}")
        for file in tree.rglob("*"):
            if file.is_symlink():
                raise ValueError(f"release-diff/preflight/data-symlink/{file.relative_to(root)}")
            if file.is_file():
                with file.open("rb") as stream:
                    observed[PurePosixPath(file.relative_to(root))] = hashlib.file_digest(stream, "sha256").hexdigest()
    if not expected:
        raise ValueError("release-diff/preflight/missing-data-file-inventory")
    changed = sorted(path for path in observed.keys() | expected.keys() if expected.get(path) != observed.get(path))
    if changed:
        raise ValueError("release-diff/preflight/data-drift: " + ", ".join(map(str, changed[:30])))
    return len(observed)


if __name__ == "__main__":
    corpus, sha, manifest = sys.argv[1:]
    count = verify(Path(corpus), sha, json.loads(Path(manifest).read_text()))
    print(f"release-diff/app-data {sha} {count} verified files")
