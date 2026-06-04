def solve(s, nums):
    right = 2
    left = 0
    best = 0
    ch = s[right]
    picked = nums[right]
    best = max(best, right - left + 1)
    return best + picked + (1 if ch else 0)
