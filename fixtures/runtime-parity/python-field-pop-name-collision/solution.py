class Bag:
    def __init__(self):
        self.items = [1, 2, 3]

    def pop(self):
        self.items.pop()
        return len(self.items)
