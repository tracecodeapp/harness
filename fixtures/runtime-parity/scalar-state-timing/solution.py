def solve(nums):
    left = 0
    right = len(nums) - 1
    left = left + 1
    right -= 1
    left += 1
    right = right - 1
    return nums[left] + nums[right]
