#include <cstdint>

class Solution {
public:
    int checksum(int rounds) {
        std::uint32_t state = 1;
        for (int i = 0; i < rounds; i++) {
            state = state * 1664525u + 1013904223u;
        }
        const auto answer = static_cast<std::int32_t>(state);
        if (answer != -748346367) __builtin_trap();
        return answer;
    }
};
