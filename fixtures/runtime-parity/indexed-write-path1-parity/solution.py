def solve(nums):
    freq = {}
    freq[1] = 2
    left = nums[0]
    freq[left] -= 1
    return freq[left]
