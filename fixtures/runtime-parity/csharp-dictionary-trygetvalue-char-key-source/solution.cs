using System.Collections.Generic;

public class Solution
{
    public int solve()
    {
        var lastSeen = new Dictionary<char, int>();
        char ch = 'a';
        lastSeen[ch] = 4;
        lastSeen.TryGetValue(ch, out int previous);
        return previous;
    }
}
