class Node {
  value: number;
  prev: Node | null = null;
  next: Node | null = null;

  constructor(value: number) {
    this.value = value;
  }
}

class Solution {
  private head: Node;
  private tail: Node;

  constructor() {
    this.head = new Node(-1);
    this.tail = new Node(-1);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  solve(value: number): number {
    const node = new Node(value);
    this.head.next!.prev = node;
    this.head.next = node;
    node.prev = this.head;
    node.next = this.tail;
    return this.head.next.value;
  }
}
