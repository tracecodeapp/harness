class Bag:
    def __init__(self):
        self.graph = {0: []}

    def add(self, value):
        self.graph[0].append(value)
        return self.graph[0]
