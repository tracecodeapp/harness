import java.util.*;

class Solution {
  public int solve(int[][] rows) {
    List<int[]> values = new ArrayList<>();
    for (int[] row : rows) {
      values.add(row);
    }
    int total = values.get(0)[1] + values.get(1)[0];
    return total;
  }
}
