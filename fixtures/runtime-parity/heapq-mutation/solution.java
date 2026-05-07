import java.util.*;

class Solution {
  public Integer solve(int[] nums) {
    PriorityQueue<Integer> heap = new PriorityQueue<>();
    heap.offer(nums[0]);
    Integer value = heap.poll();
    return value;
  }
}
