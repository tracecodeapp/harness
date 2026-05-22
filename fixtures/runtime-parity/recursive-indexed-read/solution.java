import java.util.*;

class Solution {
  public int solve() {
    List<Integer> arr = new ArrayList<>(Arrays.asList(10, 20, 30));
    List<Integer> arr2 = new ArrayList<>(Arrays.asList(0, 2));
    int value = arr.get(arr2.get(1));
    return value;
  }
}
