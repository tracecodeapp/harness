public class Solution
{
    public int solve(int[][] matrix, string[] pizza)
    {
        int cols = matrix[0].Length;
        int width = pizza[0].Length;
        return cols + width;
    }
}
