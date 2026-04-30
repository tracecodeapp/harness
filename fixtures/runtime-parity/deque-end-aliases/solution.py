from collections import deque


def solve(nums):
    deck = deque()
    deck.append(nums[0])
    deck.append(nums[1])
    deck.popleft()  # pollFirst
    deck.append(nums[2])
    deck.popleft()  # removeFirst
    deck.pop()  # pollLast
    deck.append(nums[3])
    deck.pop()  # removeLast
    return len(deck)
