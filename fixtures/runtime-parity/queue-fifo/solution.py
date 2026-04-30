from collections import deque

def solve(nums):
    queue = deque()
    for num in nums:
        queue.append(num)
    first = queue.popleft()
    return first
