def solve():
    seen = set()
    seen.add(2)
    seen.remove(2)
    return len(seen)
