def dailyTemperatures(temperatures):
    out = [0] * len(temperatures)
    stack = []

    for i in range(len(temperatures)):
        while stack and temperatures[stack[-1]] < temperatures[i]:
            prev = stack.pop()
            out[prev] = i - prev
        stack.append(i)

    return out
