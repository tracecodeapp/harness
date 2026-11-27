class Solution {
    public int checksum(int rounds) {
        int state = 1;
        for (int i = 0; i < rounds; i++) {
            state = state * 1664525 + 1013904223;
        }
        if (state != -288021375) throw new IllegalStateException("Unexpected checksum");
        return state;
    }
}
