function<bool(vector<string>)> two_pointers_converging;

two_pointers_converging = [&]( vector<string> arr ) -> bool {
    if (arr.empty()) {
        return true;
    }
    int left = 0;
    int right = (arr.size() - 1);
    while (left < right) {
        if (arr[left] != arr[right]) {
            return false;
        }
        left += 1;
        right -= 1;
    }
    return true;
};
bool result = two_pointers_converging(vector<string>{"r", "a", "c", "e", "c", "a", "r"});
