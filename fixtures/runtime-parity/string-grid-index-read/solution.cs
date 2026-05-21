public class Solution
{
    public int solve(string[] board)
    {
        int count = 0;
        for (int r = 0; r < board.Length; r++)
        {
            for (int c = 0; c < board[r].Length; c++)
            {
                if (board[r][c] == '.')
                {
                    count += 1;
                }
            }
        }
        return count;
    }
}
