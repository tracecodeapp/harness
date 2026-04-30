import heapq

def solve(nums):
    heap = []
    heapq.heappush(heap, nums[0])
    value = heapq.heappop(heap)
    return value
