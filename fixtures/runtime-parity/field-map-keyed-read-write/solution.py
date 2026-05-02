class Counter:
    def __init__(self):
        self.counts = {}

    def bump(self, key):
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    def read(self, key):
        return self.counts.get(key, 0)
