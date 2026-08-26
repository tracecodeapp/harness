using System;
using System.Collections.Generic;

public sealed class Solution
{
    public int[] TwoSum(int[] nums, int target)
    {
        var seen = new Dictionary<int, int>(nums.Length);
        for (int index = 0; index < nums.Length; index++)
        {
            int complement = target - nums[index];
            if (seen.TryGetValue(complement, out int match))
            {
                return new[] { match, index };
            }
            seen[nums[index]] = index;
        }
        return Array.Empty<int>();
    }
}

public static class TraceCodeDriver
{
    private static int executionCount;

    // Prototype for the generated TraceCLR wire boundary. Production code
    // generates this adapter from the Roslyn method symbol and records the
    // exact parameter/result contract beside the PE artifact.
    public static byte[] Run(byte[] input, Action onIteration)
    {
        int offset = 0;
        int length = ReadInt32(input, ref offset);
        if (length < 0 || length > 1_000_000)
        {
            throw new ArgumentOutOfRangeException(nameof(input), "Invalid array length.");
        }
        var nums = new int[length];
        for (int index = 0; index < nums.Length; index++)
        {
            onIteration();
            nums[index] = ReadInt32(input, ref offset);
        }
        int target = ReadInt32(input, ref offset);
        if (offset != input.Length)
        {
            throw new ArgumentException("TraceCLR input contains trailing bytes.", nameof(input));
        }

        int[] result = new Solution().TwoSum(nums, target);
        var output = new byte[checked(8 + result.Length * 4)];
        int outputOffset = 0;
        WriteInt32(output, ref outputOffset, result.Length);
        foreach (int value in result)
        {
            WriteInt32(output, ref outputOffset, value);
        }
        WriteInt32(output, ref outputOffset, ++executionCount);
        return output;
    }

    private static int ReadInt32(byte[] bytes, ref int offset)
    {
        if ((uint)offset > (uint)(bytes.Length - 4))
        {
            throw new ArgumentException("TraceCLR input ended early.", nameof(bytes));
        }
        int value = bytes[offset]
            | bytes[offset + 1] << 8
            | bytes[offset + 2] << 16
            | bytes[offset + 3] << 24;
        offset += 4;
        return value;
    }

    private static void WriteInt32(byte[] bytes, ref int offset, int value)
    {
        bytes[offset] = (byte)value;
        bytes[offset + 1] = (byte)(value >> 8);
        bytes[offset + 2] = (byte)(value >> 16);
        bytes[offset + 3] = (byte)(value >> 24);
        offset += 4;
    }
}
