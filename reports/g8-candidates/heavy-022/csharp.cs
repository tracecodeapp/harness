using System;

public class Solution {
    public int checksum(int rounds) {
        int state = 1;
        for (int i = 0; i < rounds; i++) {
            state = unchecked(state * 1664525 + 1013904223);
        }
        if (state != -432775359) throw new InvalidOperationException("Unexpected checksum");
        return state;
    }
}
