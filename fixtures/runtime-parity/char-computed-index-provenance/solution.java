class Solution {
  public int solve(String text) {
    int[] counts = new int[26];
    int base = 'a';
    for (int i = 0; i < text.length(); i++) {
      counts[text.charAt(i) - base]++;
    }
    return counts[0];
  }
}
