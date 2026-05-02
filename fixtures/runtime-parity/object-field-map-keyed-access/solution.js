class Node {
  constructor() {
    this.children = {};
  }
}

function solve(key) {
  const node = new Node();
  node.children[key] = 1;
  return node.children[key];
}
