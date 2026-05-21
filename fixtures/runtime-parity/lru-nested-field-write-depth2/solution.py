class Node:
    def __init__(self, value):
        self.value = value
        self.prev = None
        self.next = None

class Solution:
    def __init__(self):
        self.head = Node(-1)
        self.tail = Node(-1)
        self.head.next = self.tail
        self.tail.prev = self.head

    def solve(self, value):
        node = Node(value)
        self.head.next.prev = node
        self.head.next = node
        node.prev = self.head
        node.next = self.tail
        return self.head.next.value
