class Counter {
  unordered_map<string, int> counts;

public:
  Counter() {
    this->counts = unordered_map<string, int>();
  }

  int bump(string key) {
    this->counts[key] = this->counts[key] + 1;
    return this->counts[key];
  }

  int read(string key) {
    return this->counts.count(key) ? this->counts[key] : 0;
  }
};
