int search(vector<int>& nums, int target) {
  int left = 0;
  int right = nums.size() - 1;

  while (left <= right) {
    int mid = left + (right - left) / 2;

    bool hit = nums[mid] == target;
    if (hit) {
      return mid;
    }

    bool leftSorted = nums[left] <= nums[mid];
    bool targetInLeft = false;
    bool targetInRight = false;
    if (leftSorted) {
      targetInLeft = nums[left] <= target && target < nums[mid];
      if (targetInLeft) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    } else {
      targetInRight = nums[mid] < target && target <= nums[right];
      if (targetInRight) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
  }

  return -1;
}
