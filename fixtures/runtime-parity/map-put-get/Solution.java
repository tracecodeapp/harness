import java.util.*;

class Solution {
  public int solve() {
    Map<Integer, Integer> seen = new HashMap<>();
    seen.put(2, 5);
    return seen.get(2);
  }
}
