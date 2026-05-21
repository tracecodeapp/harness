import java.util.*;

class Solution {
  public int solve() {
    Map<String, Integer> rightIndex = new HashMap<>();
    int nr = 1;
    int nc = 0;
    rightIndex.put(nr + "," + nc, 42);
    Integer v = rightIndex.get(nr + "," + nc);
    return v == null ? -1 : v;
  }
}
