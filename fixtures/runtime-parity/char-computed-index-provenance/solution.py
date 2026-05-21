def solve(text):
    counts = [0] * 26
    base = ord('a')
    for i in range(len(text)):
        counts[ord(text[i]) - base] += 1
    return counts[0]
