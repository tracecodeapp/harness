import java.util.*;

class Solution {
  public int solve(List<List<String>> accounts) {
    for (List<String> account : accounts) {
      int i = 1;
      String email = account.get(i);
      return email.length();
    }
    return 0;
  }
}
