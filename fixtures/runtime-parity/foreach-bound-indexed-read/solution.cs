using System.Collections.Generic;

public class Solution
{
    public int solve(List<List<string>> accounts)
    {
        foreach (var account in accounts)
        {
            int i = 1;
            string email = account[i];
            return email.Length;
        }
        return 0;
    }
}
