using System.Collections.Generic;

public class Solution
{
    public int solve(int[] nums)
    {
        var deck = new LinkedList<int>();
        deck.AddFirst(nums[0]);
        deck.AddLast(nums[0]);
        deck.AddLast(nums[1]);
        deck.RemoveFirst();
        deck.AddLast(nums[2]);
        deck.RemoveFirst();
        deck.RemoveLast();
        deck.AddLast(nums[3]);
        deck.RemoveLast();
        return deck.Count;
    }
}
