def solve():
    seen = {}
    seen[2] = 5
    del seen[2]
    return len(seen)
