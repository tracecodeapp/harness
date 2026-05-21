class Solution {
  countRangeSum(nums, lower, upper) {
    const prefix = [0];
    for (const num of nums) {
      prefix.push(prefix[prefix.length - 1] + num);
    }
    const mergeSort = (lo, hi) => {
      if (lo >= hi) return 0;
      const mid = Math.floor((lo + hi) / 2);
      let count = mergeSort(lo, mid) + mergeSort(mid + 1, hi);
      let j = mid + 1;
      for (let left = lo; left <= mid; left++) {
        while (j <= hi && prefix[j] - prefix[left] <= upper) {
          j++;
        }
        count += j - (mid + 1);
      }
      return count;
    };
    return mergeSort(0, prefix.length - 1);
  }
}
