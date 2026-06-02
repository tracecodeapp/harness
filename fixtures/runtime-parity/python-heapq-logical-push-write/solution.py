import heapq

def solve(nums):
    heap = []
    heapq.heappush(heap, nums[0])
    heapq.heappush(heap, nums[1])
    return heap[0]
