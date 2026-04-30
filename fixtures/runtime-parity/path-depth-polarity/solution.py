class Solution:
    def __init__(self):
        self.values = [2, 5, 9]

    def solve(self):
        picked = self.values[1]
        self.values[2] = picked + self.values[0]
        return self.values
