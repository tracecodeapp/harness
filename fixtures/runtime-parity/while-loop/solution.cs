public class Solution
{
    public int solve(int n)
    {
        int i = 0;
        int total = 0;
        while (i < n)
        {
            total += i;
            i += 1;
        }

        return total;
    }
}
