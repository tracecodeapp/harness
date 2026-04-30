import java.util.*;

class NumArray {
  private int[] prefix;

  public NumArray(int[] nums) {
    this.prefix = new int[] {0};
  }

  public int sumRange(int left, int right) {
    return this.prefix[0];
  }
}
