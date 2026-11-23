#!/usr/bin/env python3
"""Qualify raw release reports against an independently enumerated manifest.

The manifest supplies appDataSha and rows of {key, graph?}. A key is the array
[language, fixture, case, mode, stopPolicy]. Pins supply {key, before, after,
reason, intendedOutcome, reviewer, decision}. Graph scope is per manifest row.
"""
import argparse
import json
from pathlib import Path


def graph_equal(left, right):
    """Compare rooted graphs with two-way identity mapping."""
    def index(root):
        definitions = {}
        refs = []

        def collect(node):
            if isinstance(node, list):
                for value in node:
                    collect(value)
            if not isinstance(node, dict):
                return
            if "__ref__" in node:
                if set(node) != {"__ref__"} or not isinstance(node["__ref__"], str):
                    raise ValueError("malformed graph reference")
                refs.append(node["__ref__"])
                return
            if "__id__" in node:
                name = node["__id__"]
                if not isinstance(name, str) or name in definitions:
                    raise ValueError("invalid or duplicate graph definition")
                definitions[name] = node
            for value in node.values():
                collect(value)

        collect(root)
        if set(refs) - definitions.keys():
            raise ValueError("dangling graph reference")
        return definitions

    lhs, rhs = index(left), index(right)
    forward, backward = {}, {}

    def compare(a, b):
        if type(a) is not type(b):
            return False
        if isinstance(a, list):
            return len(a) == len(b) and all(compare(x, y) for x, y in zip(a, b))
        if not isinstance(a, dict):
            return a == b

        def definition(node, definitions):
            if "__ref__" in node:
                return node["__ref__"], definitions[node["__ref__"]]
            return node.get("__id__"), node

        a_id, a = definition(a, lhs)
        b_id, b = definition(b, rhs)
        if (a_id is None) != (b_id is None):
            return False
        if a_id is not None:
            if a_id in forward or b_id in backward:
                return forward.get(a_id) == b_id and backward.get(b_id) == a_id
            forward[a_id], backward[b_id] = b_id, a_id
        fields = set(a) - {"__id__"}
        return fields == set(b) - {"__id__"} and all(compare(a[name], b[name]) for name in sorted(fields))

    return compare(left, right)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def unique(entries, name):
    table = {}
    for key, value in entries:
        if key in table:
            raise ValueError(f"release-diff/{name}/duplicate/{'/'.join(key)}")
        table[key] = value
    return table


def classify(manifest, before, after, pins):
    planned = unique(((tuple(row["key"]), row) for row in manifest["rows"]), "manifest")
    reviewed = unique(((tuple(pin["key"]), pin) for pin in pins), "pins")
    outstanding = []
    changes = []
    used = set()
    for key in sorted(planned.keys() | before.keys() | after.keys()):
        label = "/".join(key)
        if key not in planned:
            outstanding.append(f"release-diff/unplanned/{label}")
            continue
        if key not in before or key not in after:
            side = "baseline" if key not in before else "candidate"
            outstanding.append(f"release-diff/missing/{side}/{label}")
            continue
        a, b = before[key], after[key]
        if planned[key].get("graph") and "value" in a and "value" in b:
            equal_graph = graph_equal(a["value"], b["value"])
            if equal_graph:
                a, b = (dict((k, v) for k, v in row.items() if k != "value") for row in (a, b))
        if canonical(a) == canonical(b):
            continue
        pin = reviewed.get(key)
        if (
            pin and pin.get("decision") == "approved" and pin.get("reviewer")
            and pin.get("reason") and pin.get("intendedOutcome")
            and canonical(pin.get("before")) == canonical(before[key])
            and canonical(pin.get("after")) == canonical(after[key])
        ):
            used.add(key)
        else:
            outstanding.append(f"release-diff/unreviewed/{label}")
        changes.append({
            "key": key,
            "before": before[key],
            "after": after[key],
            "decision": "approved" if key in used else "unreviewed",
            "review": pin if key in used else None,
        })
    outstanding.extend(f"release-diff/stale-pin/{'/'.join(key)}" for key in sorted(reviewed.keys() - used))
    return changes, outstanding


def records(directory, label, manifest, digest):
    results = []
    time_bases = set()
    for path in sorted(Path(directory).glob(f"{label}-*.json")):
        report = json.loads(path.read_text())
        if not report.get("complete") or report.get("missingReferences"):
            raise ValueError(f"release-diff/incomplete/{path.name}")
        if report.get("appDataSha") != manifest["appDataSha"]:
            raise ValueError(f"release-diff/app-data/{path.name}")
        if report.get("harnessSha256") != digest:
            raise ValueError(f"release-diff/pack-digest/{path.name}")
        time_bases.add((report["browserVersion"], canonical(report["appOptions"]["hostOptions"])))
        for fixture in report["problems"]:
            language, fid = fixture["language"], fixture["id"]
            stop = "stop" if fixture.get("stopSubmitAtFirstRunaway") else "default"
            for mode, holder, evaluation, policy in (
                ("submit", fixture["submit"], "evaluation", stop),
                ("run", fixture["run"], "initial", "interactive"),
            ):
                payload = holder.get(evaluation)
                if not payload or holder.get("runnerError") or holder.get("continuationError"):
                    raise ValueError(f"release-diff/unresolved/{language}/{fid}/{mode}/{policy}")
                rows = payload["cases"]
                order = payload["caseOrder"]
                if order != list(rows) or len(order) != len(set(order)):
                    raise ValueError(f"release-diff/case-order/{language}/{fid}/{mode}/{policy}")
                header = {k: v for k, v in payload.items() if k not in {"cases", "caseOrder"}}
                header["caseOrder"] = order
                if "verdict" in holder:
                    header["verdict"] = holder["verdict"]
                results.append(((language, fid, "$evaluation", mode, policy), header))
                for case, row in rows.items():
                    results.append(((language, fid, case, mode, policy), row))
            initial = fixture["run"]["initial"]["cases"]
            drawing = fixture["run"]["continuation"]
            if initial:
                first = fixture["runCases"][0]["id"]
                for case, row in {first: initial[first], **drawing}.items():
                    if row.get("status") == "missing-case":
                        raise ValueError(f"release-diff/unresolved/{language}/{fid}/{case}/run-trace")
                    results.append(((language, fid, case, "run-trace", "interactive"), row))
    if not results or len(time_bases) != 1:
        raise ValueError(f"release-diff/inconsistent-browser-or-host-configuration/{label}")
    return unique(results, label), time_bases


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("baseline")
    parser.add_argument("candidate")
    parser.add_argument("manifest")
    parser.add_argument("pins")
    parser.add_argument("--baseline-digest", required=True)
    parser.add_argument("--candidate-digest", required=True)
    args = parser.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    pins = json.loads(Path(args.pins).read_text())
    before, base_environment = records(args.directory, args.baseline, manifest, args.baseline_digest)
    after, target_environment = records(args.directory, args.candidate, manifest, args.candidate_digest)
    if base_environment != target_environment:
        raise ValueError("release-diff/unequal-browser-or-host-configuration")
    changes, problems = classify(manifest, before, after, pins)
    receipt = {
        "appDataSha": manifest["appDataSha"],
        "baseline": {"sha256": args.baseline_digest, "rows": len(before)},
        "candidate": {"sha256": args.candidate_digest, "rows": len(after)},
        "changes": changes,
        "outstanding": problems,
    }
    Path(args.directory, "qualification.json").write_text(json.dumps(receipt, indent=2) + "\n")
    for problem in problems:
        print(problem)
    print(f"release-diff: {len(before)} baseline, {len(after)} candidate, {len(problems)} outstanding")
    return int(bool(problems))


if __name__ == "__main__":
    raise SystemExit(main())
