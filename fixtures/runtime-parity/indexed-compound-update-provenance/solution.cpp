#include <vector>
using namespace std;

int solve() {
  vector<int> dp = {1, 0, 0};
  int num = 1;
  int idx = 1;
  dp[idx] += dp[idx - num];
  return dp[idx];
}
