def solve(n):
    seen = []
    def walk(depth):
        seen.append(depth)
        if depth == 0:
            return len(seen)
        walk(depth - 1)
        seen.pop()
        return len(seen)
    return walk(n)
