public class Solution
{
    public int solve(int[] nums)
    {
        int total = 0;
        for (int i = 0; i < nums.Length; i++)
        {
            if (nums[i] < 0)
            {
                continue;
            }

            if (nums[i] == 0)
            {
                break;
            }

            total += nums[i];
        }

        return total;
    }
}
