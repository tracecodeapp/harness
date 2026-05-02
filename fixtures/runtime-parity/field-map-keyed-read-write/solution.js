class Counter {
  constructor() {
    this.counts = new Map();
  }

  bump(key) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return this.counts.get(key);
  }

  read(key) {
    return this.counts.has(key) ? this.counts.get(key) : 0;
  }
}
