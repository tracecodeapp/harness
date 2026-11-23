"""Record the packed bytes without extracting or following archive paths."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile


def manifest(archive):
    members = {}
    with tarfile.open(archive, "r|gz") as package:
        for member in package:
            name = PurePosixPath(member.name)
            if name.parts[:1] != ("package",) or ".." in name.parts or str(name) in members:
                raise ValueError(f"G7/pack/member-path: {member.name}")
            if not (member.isfile() or member.isdir()):
                raise ValueError(f"G7/pack/member-type: {member.name}: {member.type!r}")
            content = None
            if member.isfile():
                with package.extractfile(member) as stream:
                    content = hashlib.file_digest(stream, "sha256").hexdigest()
            members[str(name)] = dict(
                path=str(name), mode=oct(member.mode), size=member.size,
                type="file" if member.isfile() else "directory", sha256=content,
            )
    return sorted(members.values(), key=lambda member: member["path"])


def compare(before, after):
    lhs = {member["path"]: member for member in before}
    rhs = {member["path"]: member for member in after}
    shared = lhs.keys() & rhs.keys()
    changed = [
        {"path": name, "before": lhs[name], "after": rhs[name]}
        for name in sorted(shared) if lhs[name] != rhs[name]
    ]
    return {
        "beforeCount": len(lhs), "afterCount": len(rhs),
        "unchangedCount": len(shared) - len(changed),
        "removed": [lhs[name] for name in sorted(lhs.keys() - rhs.keys())],
        "added": [rhs[name] for name in sorted(rhs.keys() - lhs.keys())],
        "changed": changed,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive")
    parser.add_argument("output", type=Path)
    parser.add_argument("--against", help="A second archive to compare member by member")
    args = parser.parse_args()
    before = manifest(args.archive)
    if args.against:
        result = compare(before, manifest(args.against))
        result["archives"] = []
        for path in [args.archive, args.against]:
            with open(path, "rb") as stream:
                result["archives"].append({"file": Path(path).name, "sha256": hashlib.file_digest(stream, "sha256").hexdigest()})
    else:
        result = before
    args.output.write_text(json.dumps(result, indent=2) + "\n")
