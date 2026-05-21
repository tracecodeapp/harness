public class Solution
{
    public int solve(int[] nums)
    {
        int[] left = nums[0..2];
        int[] merged = new int[] { 0, 0 };
        int i = 0;
        int k = 0;
        int pulled = left[i++];
        merged[k++] = pulled;
        int mid = 2;
        int[] tail = nums[mid..];
        int[] head = nums[0..mid];
        return merged[0] + tail[0] + head[0] + i + k;
    }
}
