public class Solution
{
    public int[] solve(int[] left, int[] right)
    {
        int[] merged = new int[3];
        int i = 1;
        int j = 1;
        int k = 2;
        if (left[i] <= right[j]) merged[k++] = left[i++];
        else merged[k++] = right[j++];
        return merged;
    }
}
