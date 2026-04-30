class Bag:
    def __init__(self):
        self.items = []

    def add(self, value):
        self.items.append(value)
        return len(self.items)
