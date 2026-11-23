import copy
import unittest
import json
from pathlib import Path
import tempfile
from compare import classify, graph_equal, records


class QualificationControls(unittest.TestCase):
    def test_seeded_regressions_use_exact_row_keys(self):
        key = ("python", "graph", "case-1", "submit", "default")
        label = "/".join(key)
        manifest = {"rows": [{"key": key, "graph": True}]}
        graph = {
            "__id__": "root", "__type__": "TreeNode", "val": 1,
            "left": {"__id__": "child", "__type__": "TreeNode", "val": 2, "next": {"__ref__": "root"}},
            "right": {"__ref__": "child"},
        }
        baseline = {key: {"status": "completed", "verdict": {"kind": "passed"}, "value": graph}}
        self.assertEqual(classify(manifest, baseline, copy.deepcopy(baseline), []), ([], []))
        renamed = copy.deepcopy(baseline)
        renamed[key]["value"]["__id__"] = "r"
        renamed[key]["value"]["left"]["__id__"] = "l"
        renamed[key]["value"]["left"]["next"]["__ref__"] = "r"
        renamed[key]["value"]["right"]["__ref__"] = "l"
        self.assertEqual(classify(manifest, baseline, renamed, []), ([], []))

        verdict = copy.deepcopy(baseline)
        verdict[key]["verdict"]["kind"] = "failed"
        topology = copy.deepcopy(baseline)
        topology[key]["value"]["right"] = {
            "__id__": "distinct", "__type__": "TreeNode", "val": 2, "next": {"__ref__": "root"},
        }
        for seed, mutant, code in (
            ("verdict-flip", verdict, "unreviewed"),
            ("dropped-row", {}, "missing/candidate"),
            ("topology-only", topology, "unreviewed"),
        ):
            with self.subTest(seed=seed):
                changes, issues = classify(manifest, baseline, mutant, [])
                self.assertEqual(issues, [f"release-diff/{code}/{label}"])
                if mutant:
                    self.assertEqual(len(changes), 1)
                    self.assertEqual(changes[0]["key"], key)
                    self.assertEqual(changes[0]["before"], baseline[key])
                    self.assertEqual(changes[0]["after"], mutant[key])
                print(f"release-diff/control/{seed} hit=1 {issues[0]}")

        approval = {
            "key": key, "decision": "approved", "reviewer": "Fixture reviewer",
            "reason": "Known fixture change", "intendedOutcome": "Failed verdict",
            "before": baseline[key], "after": verdict[key],
        }
        changes, issues = classify(manifest, baseline, verdict, [approval])
        self.assertEqual(issues, [])
        self.assertEqual(changes[0]["review"], approval)
        self.assertEqual(classify(manifest, baseline, copy.deepcopy(baseline), []), ([], []))

    def test_rejects_report_from_a_different_package(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "target-python.json").write_text(json.dumps({
                "complete": True, "appDataSha": "same", "harnessSha256": "stale",
            }))
            with self.assertRaisesRegex(ValueError, r"release-diff/pack-digest/target-python.json"):
                records(directory, "target", {"appDataSha": "same"}, "carried")

    def test_graph_labels_and_values_are_observable(self):
        graph = {"__id__": "root", "left": None, "self": {"__ref__": "root"}}
        for other in (
            {"__id__": "r", "left": None, "self": {"__ref__": "r"}, "value": 1},
            {"__id__": "r", "self": {"__ref__": "r"}},
            {"__id__": "r", "left": None, "self": {"__id__": "new", "left": None, "self": {"__ref__": "r"}}},
        ):
            self.assertFalse(graph_equal(graph, other))
        with self.assertRaisesRegex(ValueError, "dangling"):
            graph_equal(graph, {"__id__": "r", "left": None, "self": {"__ref__": "missing"}})


if __name__ == "__main__":
    unittest.main()
