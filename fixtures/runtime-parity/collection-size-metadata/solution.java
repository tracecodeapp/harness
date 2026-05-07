import java.util.*;

class Solution {
  public int solve(int[] nums) {
    int total = 0;
    int n = nums.length;
    Map<Integer, Boolean> seen = new HashMap<>(Map.of(1, true, 2, true));
    int m = seen.size();
    return n + m + total;
  }
}
