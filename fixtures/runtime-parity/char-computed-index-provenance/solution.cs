public class Solution
{
    public int solve(string text)
    {
        int[] counts = new int[26];
        int baseChar = 'a';
        for (int i = 0; i < text.Length; i++)
        {
            counts[text[i] - baseChar]++;
        }
        return counts[0];
    }
}
