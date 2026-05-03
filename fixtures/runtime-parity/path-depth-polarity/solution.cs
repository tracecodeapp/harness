public class Solution
{
    private int[][] values = new int[][] { new int[] { 2, 5 }, new int[] { 9, 4 } };

    public int[][] solve()
    {
        int picked = values[0][1];
        values[1][0] = picked + values[0][0];
        return values;
    }
}
