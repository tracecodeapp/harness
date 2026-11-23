"""Compare packed contents and metadata without extracting them."""
import hashlib
import json
import sys
import tarfile


def inventory(path):
    with open(path, "rb") as archive:
        gzip_header = archive.read(10).hex()
    members = {}
    with tarfile.open(path, "r|gz") as archive:
        for entry in archive:
            payload = archive.extractfile(entry) if entry.isfile() else None
            members[entry.name] = {
                "sha256": hashlib.file_digest(payload, "sha256").hexdigest() if payload else None,
                "size": entry.size,
                "mode": entry.mode,
                "uid": entry.uid,
                "gid": entry.gid,
                "mtime": entry.mtime,
                "type": entry.type.decode("ascii"),
                "link": entry.linkname,
                "pax": entry.pax_headers,
            }
    return gzip_header, members


canonical_header, canonical = inventory(sys.argv[1])
local_header, local = inventory(sys.argv[2])
print(json.dumps({
    "onlyCanonical": sorted(canonical.keys() - local.keys()),
    "onlyLocal": sorted(local.keys() - canonical.keys()),
    "changed": {
        path: {"canonical": canonical[path], "local": local[path]}
        for path in sorted(canonical.keys() & local.keys())
        if canonical[path] != local[path]
    },
    "orderMatches": list(canonical) == list(local),
    "gzipHeader": {"canonical": canonical_header, "local": local_header},
}, indent=2))
