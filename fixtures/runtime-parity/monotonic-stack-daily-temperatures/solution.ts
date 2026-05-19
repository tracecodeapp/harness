/**
 * Practice reference solution scaffold
 * id: daily-temperatures
 * language: typescript
 * executionStyle: solution-method
 */
class Solution {
  dailyTemperatures(temperatures: number[]): number[] {
    const out: number[] = Array(temperatures.length).fill(0);
    const stack: number[] = [];

    for (let i = 0; i < temperatures.length; i += 1) {
      while (stack.length > 0 && temperatures[i] > temperatures[stack[stack.length - 1]]) {
        const prev = stack.pop() as number;
        out[prev] = i - prev;
      }
      stack.push(i);
    }

    return out;
  }
}
