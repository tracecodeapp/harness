public class Solution
{
    public int solve(ListNode head)
    {
        ListNode alias = head;
        return alias.next.val;
    }
}
