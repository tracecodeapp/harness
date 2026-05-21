class Node {
  constructor(value) {
    this.value = value;
    this.prev = null;
    this.next = null;
  }
}

class Solution {
  constructor() {
    this.head = new Node(-1);
    this.tail = new Node(-1);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  solve(value) {
    const node = new Node(value);
    this.head.next.prev = node;
    this.head.next = node;
    node.prev = this.head;
    node.next = this.tail;
    return this.head.next.value;
  }
}
