import java.util.*;

class Solution {
  public boolean solve() {
    Map<Integer, Integer> seen = new HashMap<>();
    seen.put(2, 5);
    return seen.containsKey(2);
  }
}
