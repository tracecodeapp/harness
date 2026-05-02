class Node {
  children: Record<string, number>;

  constructor() {
    this.children = {};
  }
}

function solve(key: string): number {
  const node = new Node();
  node.children[key] = 1;
  return node.children[key];
}
