class Bucket:
    def __init__(self):
        self.keys = []


def solve(n):
    graph = {0: []}
    graph[0].append(1)
    bucket = Bucket()
    bucket.keys.append(2)
    return len(graph[0]) + len(bucket.keys)
