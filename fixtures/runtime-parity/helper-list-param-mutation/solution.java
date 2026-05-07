import java.util.*;

class Solution {
  public void appendValue(List<Integer> out, int value) {
    out.add(value);
  }

  public List<Integer> solve(int value) {
    List<Integer> out = new ArrayList<>();
    appendValue(out, value);
    return out;
  }
}
