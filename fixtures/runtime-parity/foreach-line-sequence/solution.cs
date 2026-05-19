public class Solution
{
    public int solve(int[] values)
    {
        int total = 0;
        foreach (int value in values)
        {
            total += value;
        }
        return total;
    }
}
