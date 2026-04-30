class Bag {
  constructor() {
    this.graph = new Map([[0, []]]);
  }

  add(value) {
    this.graph.get(0).push(value);
    return this.graph.get(0);
  }
}
