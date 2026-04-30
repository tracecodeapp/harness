class Solution:
    def __init__(self):
        self.graph = []

    def solve(self, n):
        self.graph = [[] for _ in range(n)]
        self.graph[0].append(1)
        return self.graph
