def solve(items):
    seen = {}
    for item in items:
        seen[item] = len(item)
    return seen[items[0]]
