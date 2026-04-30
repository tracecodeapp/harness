class Solution {
  constructor() {
    this.values = [2, 5, 9];
  }

  solve() {
    const picked = this.values[1];
    this.values[2] = picked + this.values[0];
    return this.values;
  }
}
