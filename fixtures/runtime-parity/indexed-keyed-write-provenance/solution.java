import java.util.*;

class Solution {
  public int solve(String[] items) {
    Map<String, Integer> seen = new HashMap<>();
    for (String item : items) {
      seen.put(item, item.length());
    }
    return seen.get(items[0]);
  }
}
