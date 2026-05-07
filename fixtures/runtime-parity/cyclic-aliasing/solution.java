class ListNode {
  int val;
  ListNode next;
  ListNode(int val) {
    this.val = val;
  }
}

class Solution {
  public int solve(ListNode head) {
    ListNode alias = head;
    return alias.next.val;
  }
}
