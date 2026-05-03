public class Solution
{
    public int solve(int[] nums)
    {
        int total = 0;
        for (int i = 0; i < nums.Length; i++)
        {
            total += nums[i];
        }

        return total;
    }
}
