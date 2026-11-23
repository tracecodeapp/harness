"""Record the packed bytes without extracting or following archive paths."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
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


if __name__ == "__main__":
    Path(sys.argv[2]).write_text(json.dumps(manifest(sys.argv[1]), indent=2) + "\n")
