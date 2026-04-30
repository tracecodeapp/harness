from collections import deque

def solve(nums):
    window = deque(nums)
    last = window[2]
    return last
