class Bag {
  vector<int> items;
public:
  Bag() {
    this->items = vector<int>();
  }

  int add(int value) {
    this->items.push_back(value);
    return this->items.size();
  }
};
