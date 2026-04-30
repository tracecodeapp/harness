class Bag {
  private graph: Map<number, number[]>;

  constructor() {
    this.graph = new Map([[0, []]]);
  }

  add(value: number): number[] {
    this.graph.get(0)!.push(value);
    return this.graph.get(0)!;
  }
}
