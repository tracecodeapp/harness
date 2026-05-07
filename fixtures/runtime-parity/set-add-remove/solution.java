import java.util.*;

class Solution {
  public int solve() {
    Set<Integer> seen = new HashSet<>();
    seen.add(2);
    seen.remove(2);
    return seen.size();
  }
}
