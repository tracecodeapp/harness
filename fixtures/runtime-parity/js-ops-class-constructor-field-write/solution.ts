class NumArray {
  private prefix: number[];

  constructor(nums: number[]) {
    this.prefix = [0];
  }

  sumRange(left: number, right: number): number {
    return this.prefix[0];
  }
}
