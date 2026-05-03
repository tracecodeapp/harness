public class Solution
{
    public int fail()
    {
        throw new System.InvalidOperationException("bad input");
    }

    public int solve(int n)
    {
        try
        {
            fail();
        }
        catch (System.InvalidOperationException)
        {
            return n;
        }

        return n;
    }
}
