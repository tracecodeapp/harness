/**
 * Practice reference solution scaffold
 * id: daily-temperatures
 * language: cplusplus
 * executionStyle: solution-method
 */
#include <vector>
#include <stack>

class Solution {
public:
    std::vector<int> dailyTemperatures(std::vector<int>& temperatures) {
        int n = static_cast<int>(temperatures.size());
        std::vector<int> out(n, 0);
        std::stack<int> stk;

        for (int i = 0; i < n; ++i) {
            while (!stk.empty() && temperatures[i] > temperatures[stk.top()]) {
                int prev = stk.top();
                stk.pop();
                out[prev] = i - prev;
            }
            stk.push(i);
        }

        return out;
    }
};
