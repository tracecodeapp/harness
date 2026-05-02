class Node:
    def __init__(self):
        self.children = {}


def solve(key):
    node = Node()
    node.children[key] = 1
    return node.children[key]
