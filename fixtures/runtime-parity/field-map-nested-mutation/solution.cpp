class Bag {
  unordered_map<int, vector<int>> graph;

public:
  Bag() {
    this->graph = unordered_map<int, vector<int>>{{0, {}}};
  }

  vector<int> add(int value) {
    this->graph[0].push_back(value);
    return this->graph[0];
  }
};
