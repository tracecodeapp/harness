class Bag {
  private items: number[];

  constructor() {
    this.items = [];
  }

  add(value: number): number {
    this.items.push(value);
    return this.items.length;
  }
}
