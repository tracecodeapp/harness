import java.util.*;

class Solution {
  public int solve(int[] nums) {
    Queue<Integer> queue = new ArrayDeque<>();
    for (int num : nums) {
      queue.offer(num);
    }
    int first = queue.poll();
    return first;
  }
}
