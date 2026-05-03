public class Solution
{
    public int solve()
    {
        int[][] grid = new int[][] { new int[] { 0, 0 }, new int[] { 0, 0 } };
        grid[1][0] += 1;
        return grid[1][0];
    }
}
