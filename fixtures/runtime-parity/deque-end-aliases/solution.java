import java.util.*;

class Solution {
  public int solve(int[] nums) {
    Deque<Integer> deck = new ArrayDeque<>();
    deck.offerFirst(nums[0]);
    deck.offerLast(nums[0]);
    deck.addLast(nums[1]);
    deck.pollFirst();
    deck.offerLast(nums[2]);
    deck.removeFirst();
    deck.pollLast();
    deck.addLast(nums[3]);
    deck.removeLast();
    return deck.size();
  }
}
