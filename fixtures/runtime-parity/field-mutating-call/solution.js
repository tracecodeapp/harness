class Bag {
  constructor() {
    this.items = [];
  }

  add(value) {
    this.items.push(value);
    return this.items.length;
  }
}
