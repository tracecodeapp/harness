class Bucket {
  keys: number[];

  constructor() {
    this.keys = [];
  }
}

function solve(n: number): number {
  const graph = new Map<number, number[]>();
  graph.set(0, []);
  graph.get(0)!.push(1);
  const bucket = new Bucket();
  bucket.keys.push(2);
  return graph.get(0)!.length + bucket.keys.length;
}
