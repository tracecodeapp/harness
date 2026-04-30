def solve():
    counts = {"a": 2, "b": 1}
    counts["a"] -= 1
    counts.pop("b")
    return counts.get("a", 0) + len(counts)
