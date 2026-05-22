import java.util.*;

class Solution {
  public List<Integer> solve() {
    List<Integer> arr = new ArrayList<>(Arrays.asList(10, 20, 30));
    List<Integer> arr2 = new ArrayList<>(Arrays.asList(0, 2));
    arr.set(arr2.get(1), 99);
    return arr;
  }
}
