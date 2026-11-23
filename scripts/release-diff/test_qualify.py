import copy
import unittest
from compare import check, graph_equal


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
        self.assertEqual(check(manifest, baseline, copy.deepcopy(baseline), []), [])
        renamed = copy.deepcopy(baseline)
        renamed[key]["value"]["__id__"] = "r"
        renamed[key]["value"]["left"]["__id__"] = "l"
        renamed[key]["value"]["left"]["next"]["__ref__"] = "r"
        renamed[key]["value"]["right"]["__ref__"] = "l"
        self.assertEqual(check(manifest, baseline, renamed, []), [])

        verdict = copy.deepcopy(baseline)
        verdict[key]["verdict"]["kind"] = "failed"
        topology = copy.deepcopy(baseline)
        topology[key]["value"]["right"] = {
            "__id__": "distinct", "__type__": "TreeNode", "val": 2, "next": {"__ref__": "root"},
        }
        for mutant, code in (
            (verdict, "unreviewed"), ({}, "missing/candidate"), (topology, "unreviewed"),
        ):
            self.assertEqual(check(manifest, baseline, mutant, []), [f"release-diff/{code}/{label}"])
        self.assertEqual(check(manifest, baseline, copy.deepcopy(baseline), []), [])

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
