public class Solution
{
    public int solve(int[] nums)
    {
        int total = 0;
        for (int i = 0; i < nums.Length; i++)
        {
            int num = nums[i];
            total += num;
        }

        return total;
    }
}
