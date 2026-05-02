class Bucket {
  constructor() {
    this.keys = [];
  }
}

function solve(n) {
  const graph = new Map();
  graph.set(0, []);
  graph.get(0).push(1);
  const bucket = new Bucket();
  bucket.keys.push(2);
  return graph.get(0).length + bucket.keys.length;
}
