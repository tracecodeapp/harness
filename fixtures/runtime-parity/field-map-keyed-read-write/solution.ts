class Counter {
  private counts: Map<string, number>;

  constructor() {
    this.counts = new Map<string, number>();
  }

  bump(key: string): number {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    return this.counts.get(key) ?? 0;
  }

  read(key: string): number {
    return this.counts.has(key) ? this.counts.get(key) ?? 0 : 0;
  }
}
