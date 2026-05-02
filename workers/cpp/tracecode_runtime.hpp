#pragma once

#include <array>
#include <cstdlib>
#include <cstdio>
#include <deque>
#include <map>
#include <queue>
#include <set>
#include <stack>
#include <string>
#include <type_traits>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace tracecode {

inline int& trace_event_count() {
  static int value = 0;
  return value;
}

inline int& trace_event_budget() {
  static int value = 10000;
  return value;
}

inline bool& trace_budget_exceeded() {
  static bool value = false;
  return value;
}

inline int& current_trace_line() {
  static int value = 1;
  return value;
}

struct TreeNode {
  int val;
  int value;
  TreeNode* left;
  TreeNode* right;

  TreeNode() : val(0), value(0), left(nullptr), right(nullptr) {}
  TreeNode(int x) : val(x), value(x), left(nullptr), right(nullptr) {}
  TreeNode(int x, TreeNode* leftNode, TreeNode* rightNode) : val(x), value(x), left(leftNode), right(rightNode) {}
};

struct ListNode {
  int val;
  int value;
  ListNode* next;

  ListNode() : val(0), value(0), next(nullptr) {}
  ListNode(int x) : val(x), value(x), next(nullptr) {}
  ListNode(int x, ListNode* nextNode) : val(x), value(x), next(nextNode) {}
};

inline std::string escape_json_string(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size() + 2);
  for (char ch : value) {
    if (ch == '\\') {
      escaped += "\\\\";
    } else if (ch == '"') {
      escaped += "\\\"";
    } else if (ch == '\n') {
      escaped += "\\n";
    } else if (ch == '\r') {
      escaped += "\\r";
    } else if (ch == '\t') {
      escaped += "\\t";
    } else {
      escaped += ch;
    }
  }
  return escaped;
}

inline std::string to_json(const std::string& value) {
  return "\"" + escape_json_string(value) + "\"";
}

inline std::string to_json(const char* value) {
  return to_json(std::string(value));
}

inline std::string to_json(char value) {
  return to_json(std::string(1, value));
}

inline std::string to_json(bool value) {
  return value ? "true" : "false";
}

template <typename T>
std::enable_if_t<std::is_arithmetic_v<T> && !std::is_same_v<T, bool>, std::string>
to_json(T value) {
  return std::to_string(value);
}

inline std::string tracecode_ref_id(std::unordered_map<const void*, std::string>& refs) {
  return std::string("ref-") + std::to_string(refs.size());
}

inline std::string to_json_tree_node(TreeNode* node, std::unordered_map<const void*, std::string>& refs) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_ref_id(refs);
  refs[node] = id;
  return std::string("{\"__type__\":\"TreeNode\",\"__id__\":") + to_json(id) +
    ",\"val\":" + to_json(node->val) +
    ",\"left\":" + to_json_tree_node(node->left, refs) +
    ",\"right\":" + to_json_tree_node(node->right, refs) + "}";
}

inline std::string to_json(TreeNode* node) {
  std::unordered_map<const void*, std::string> refs;
  return to_json_tree_node(node, refs);
}

inline std::string to_json(const TreeNode* node) {
  return to_json(const_cast<TreeNode*>(node));
}

inline std::string to_json_list_node(ListNode* node, std::unordered_map<const void*, std::string>& refs) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_ref_id(refs);
  refs[node] = id;
  return std::string("{\"__type__\":\"ListNode\",\"__id__\":") + to_json(id) +
    ",\"val\":" + to_json(node->val) +
    ",\"next\":" + to_json_list_node(node->next, refs) + "}";
}

inline std::string to_json(ListNode* node) {
  std::unordered_map<const void*, std::string> refs;
  return to_json_list_node(node, refs);
}

inline std::string to_json(const ListNode* node) {
  return to_json(const_cast<ListNode*>(node));
}

template <typename T>
std::string to_json_key(const T& value) {
  if constexpr (std::is_same_v<std::decay_t<T>, std::string>) {
    return escape_json_string(value);
  } else if constexpr (std::is_same_v<std::decay_t<T>, const char*> || std::is_same_v<std::decay_t<T>, char*>) {
    return escape_json_string(std::string(value));
  } else if constexpr (std::is_same_v<std::decay_t<T>, char>) {
    return escape_json_string(std::string(1, value));
  } else if constexpr (std::is_arithmetic_v<std::decay_t<T>>) {
    return std::to_string(value);
  } else {
    return escape_json_string(to_json(value));
  }
}

template <typename A, typename B>
std::string to_json(const std::pair<A, B>& value) {
  return "[" + to_json(value.first) + "," + to_json(value.second) + "]";
}

template <typename Tuple, std::size_t... Indices>
std::string tuple_to_json(const Tuple& value, std::index_sequence<Indices...>) {
  std::string json = "[";
  std::size_t count = 0;
  ((json += (count++ > 0 ? "," : "") + to_json(std::get<Indices>(value))), ...);
  json += "]";
  return json;
}

template <typename... Values>
std::string to_json(const std::tuple<Values...>& value) {
  return tuple_to_json(value, std::index_sequence_for<Values...>{});
}

template <typename T>
std::string to_json(const std::vector<T>& values) {
  std::string json = "[";
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) json += ",";
    json += to_json(values[index]);
  }
  json += "]";
  return json;
}

template <typename T, std::size_t Size>
std::string to_json(const std::array<T, Size>& values) {
  std::string json = "[";
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) json += ",";
    json += to_json(values[index]);
  }
  json += "]";
  return json;
}

template <typename T>
std::string to_json(const std::deque<T>& values) {
  std::string json = "[";
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index > 0) json += ",";
    json += to_json(values[index]);
  }
  json += "]";
  return json;
}

template <typename K, typename V>
std::string to_json(const std::map<K, V>& values);

template <typename T>
std::string to_json(const std::set<T>& values);

template <typename T>
std::string to_json(const std::unordered_set<T>& values);

inline void write_trace_event_json(const std::string& event_json, int line = 1);

inline std::string target_json(const std::string& name) {
  return std::string("{\"variable\":") + to_json(name) + "}";
}

template <typename T>
inline void emit_snapshot_value(const std::string& name, const T& value, int line) {
  write_trace_event_json(
    std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
    ",\"target\":" + target_json(name) +
    ",\"value\":" + to_json(value) + "}",
    line
  );
}

inline std::string target_json(const std::string& name, std::size_t index) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + std::to_string(index) + "]}";
}

inline std::string target_json(const std::string& name, std::size_t outer, std::size_t inner) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + std::to_string(outer) + "," + std::to_string(inner) + "]}";
}

template <typename K>
inline std::string target_json_key(const std::string& name, const K& key) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + to_json(key) + "]}";
}

template <typename T>
struct is_std_vector : std::false_type {};

template <typename T, typename Allocator>
struct is_std_vector<std::vector<T, Allocator>> : std::true_type {};

template <typename T>
class VectorElementRef;

template <typename T>
class NestedVectorElementRef;

template <typename T>
class Vector {
 public:
  using value_type = T;
  using iterator = typename std::vector<T>::iterator;
  using const_iterator = typename std::vector<T>::const_iterator;

  Vector() : values_(), name_("vector"), path_prefix_json_(""), trace_(false) {}

  Vector(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Vector(const char* name, const char* field, int line)
      : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Vector(std::initializer_list<T> values) : values_(values), name_("vector"), path_prefix_json_(""), trace_(false) {}

  Vector(std::initializer_list<T> values, const char* name, int line)
      : values_(values), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Vector(std::initializer_list<T> values, const char* name, const char* field, int line)
      : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Vector(const std::vector<T>& values, const char* name, int line)
      : values_(values), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Vector(const std::vector<T>& values, const char* name, const char* field, int line)
      : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Vector& operator=(const std::vector<T>& values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Vector& operator=(std::initializer_list<T> values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  VectorElementRef<T> operator[](std::size_t index) {
    return VectorElementRef<T>(*this, index);
  }

  const T& operator[](std::size_t index) const {
    emit_read(index, current_trace_line());
    return values_[index];
  }

  T& at(std::size_t index) {
    emit_read(index, current_trace_line());
    return values_.at(index);
  }

  const T& at(std::size_t index) const {
    emit_read(index, current_trace_line());
    return values_.at(index);
  }

  VectorElementRef<T> front() {
    return VectorElementRef<T>(*this, 0);
  }

  const T& front() const {
    emit_read(0, current_trace_line());
    return values_.front();
  }

  VectorElementRef<T> back() {
    return VectorElementRef<T>(*this, values_.size() - 1);
  }

  const T& back() const {
    emit_read(values_.size() - 1, current_trace_line());
    return values_.back();
  }

  void push_back(const T& value) {
    values_.push_back(value);
    emit_mutate("push_back", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void pop_back() {
    values_.pop_back();
    emit_mutate("pop_back", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void resize(std::size_t count) {
    values_.resize(count);
    emit_mutate("resize", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void resize(std::size_t count, const T& value) {
    values_.resize(count, value);
    emit_mutate("resize", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void assign(std::size_t count, const T& value) {
    values_.assign(count, value);
    emit_mutate("assign", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void assign(std::initializer_list<T> values) {
    values_.assign(values);
    emit_mutate("assign", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  iterator insert(const_iterator position, const T& value) {
    auto result = values_.insert(position, value);
    emit_mutate("insert", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  iterator erase(const_iterator position) {
    auto result = values_.erase(position);
    emit_mutate("erase", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  iterator erase(const_iterator first, const_iterator last) {
    auto result = values_.erase(first, last);
    emit_mutate("erase", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  iterator begin() { return values_.begin(); }
  iterator end() { return values_.end(); }
  const_iterator begin() const { return values_.begin(); }
  const_iterator end() const { return values_.end(); }

  std::vector<T>& raw() { return values_; }
  const std::vector<T>& raw() const { return values_; }

  operator std::vector<T>&() { return values_; }
  operator const std::vector<T>&() const { return values_; }

  void emit_read(std::size_t index, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(index) +
      ",\"value\":" + to_json(values_[index]) + "}",
      line
    );
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  emit_nested_read(std::size_t outer, std::size_t inner, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(outer, inner) +
      ",\"value\":" + to_json(values_[outer][inner]) + "}",
      line
    );
  }

  void emit_write(std::size_t index, const T& value, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(index) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  emit_nested_write(std::size_t outer, std::size_t inner, const typename U::value_type& value, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(outer, inner) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  void emit_indexed_mutate(std::size_t index, const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(index) +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

 private:
  std::vector<T> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json(std::size_t index) const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_, index);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + std::to_string(index) + "]}";
  }

  std::string target_json(std::size_t outer, std::size_t inner) const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_, outer, inner);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + std::to_string(outer) + "," + std::to_string(inner) + "]}";
  }

  void emit_write_field(int line) {
    if (!trace_ || path_prefix_json_.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

  friend class VectorElementRef<T>;
  template <typename U>
  friend class NestedVectorElementRef;
  template <typename U>
  friend void swap(VectorElementRef<U> left, VectorElementRef<U> right);
};

template <typename T>
class VectorElementRef {
 public:
  VectorElementRef(Vector<T>& owner, std::size_t index) : owner_(owner), index_(index) {}

  operator T() const {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_];
  }

  VectorElementRef& operator=(const T& value) {
    owner_.values_[index_] = value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator+=(const T& value) {
    owner_.values_[index_] += value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator-=(const T& value) {
    owner_.values_[index_] -= value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, NestedVectorElementRef<typename U::value_type>>
  operator[](std::size_t innerIndex) {
    return NestedVectorElementRef<typename U::value_type>(
      reinterpret_cast<Vector<std::vector<typename U::value_type>>&>(owner_),
      index_,
      innerIndex
    );
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  push_back(const typename U::value_type& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_].push_back(value);
    owner_.emit_indexed_mutate(index_, "push_back", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  pop_back() {
    owner_.values_[index_].pop_back();
    owner_.emit_indexed_mutate(index_, "pop_back", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::iterator>
  begin() {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].begin();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::iterator>
  end() {
    return owner_.values_[index_].end();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_iterator>
  begin() const {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].begin();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_iterator>
  end() const {
    return owner_.values_[index_].end();
  }

 private:
  Vector<T>& owner_;
  std::size_t index_;

  template <typename U>
  friend void swap(VectorElementRef<U> left, VectorElementRef<U> right);
};

template <typename T>
void swap(VectorElementRef<T> left, VectorElementRef<T> right) {
  T value = left.owner_.values_[left.index_];
  left.owner_.values_[left.index_] = right.owner_.values_[right.index_];
  right.owner_.values_[right.index_] = value;
  left.owner_.emit_write(left.index_, left.owner_.values_[left.index_], current_trace_line());
  right.owner_.emit_write(right.index_, right.owner_.values_[right.index_], current_trace_line());
}

template <typename T>
class NestedVectorElementRef {
 public:
  NestedVectorElementRef(Vector<std::vector<T>>& owner, std::size_t outer, std::size_t inner)
      : owner_(owner), outer_(outer), inner_(inner) {}

  operator T() const {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_];
  }

  NestedVectorElementRef& operator=(const T& value) {
    owner_.values_[outer_][inner_] = value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator+=(const T& value) {
    owner_.values_[outer_][inner_] += value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

 private:
  Vector<std::vector<T>>& owner_;
  std::size_t outer_;
  std::size_t inner_;
};

template <typename T>
std::string to_json(const Vector<T>& values) {
  return to_json(values.raw());
}

template <typename T>
class DequeElementRef;

template <typename T>
class Deque {
 public:
  using value_type = T;
  using iterator = typename std::deque<T>::iterator;
  using const_iterator = typename std::deque<T>::const_iterator;

  Deque() : values_(), name_("deque"), path_prefix_json_(""), trace_(false) {}
  Deque(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Deque(const char* name, const char* field, int line) : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Deque(std::initializer_list<T> values) : values_(values), name_("deque"), path_prefix_json_(""), trace_(false) {}
  Deque(std::initializer_list<T> values, const char* name, int line) : values_(values), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Deque(std::initializer_list<T> values, const char* name, const char* field, int line) : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Deque(const std::deque<T>& values, const char* name, int line) : values_(values), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Deque(const std::deque<T>& values, const char* name, const char* field, int line) : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  Deque& operator=(const std::deque<T>& values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Deque& operator=(std::initializer_list<T> values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  DequeElementRef<T> operator[](std::size_t index) { return DequeElementRef<T>(*this, index); }

  const T& operator[](std::size_t index) const {
    emit_read(index, current_trace_line());
    return values_[index];
  }

  DequeElementRef<T> front() { return DequeElementRef<T>(*this, 0); }

  const T& front() const {
    emit_read(0, current_trace_line());
    return values_.front();
  }

  DequeElementRef<T> back() { return DequeElementRef<T>(*this, values_.size() - 1); }

  const T& back() const {
    emit_read(values_.size() - 1, current_trace_line());
    return values_.back();
  }

  void push_back(const T& value) {
    values_.push_back(value);
    emit_mutate("push_back", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void push_front(const T& value) {
    values_.push_front(value);
    emit_mutate("push_front", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void pop_back() {
    values_.pop_back();
    emit_mutate("pop_back", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void pop_front() {
    values_.pop_front();
    emit_mutate("pop_front", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  iterator begin() { return values_.begin(); }
  iterator end() { return values_.end(); }
  const_iterator begin() const { return values_.begin(); }
  const_iterator end() const { return values_.end(); }

  std::deque<T>& raw() { return values_; }
  const std::deque<T>& raw() const { return values_; }
  operator std::deque<T>&() { return values_; }
  operator const std::deque<T>&() const { return values_; }

  void emit_read(std::size_t index, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(index) +
      ",\"value\":" + to_json(values_[index]) + "}",
      line
    );
  }

  void emit_write(std::size_t index, const T& value, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(index) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

 private:
  std::deque<T> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json(std::size_t index) const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_, index);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + std::to_string(index) + "]}";
  }

  void emit_write_field(int line) {
    if (!trace_ || path_prefix_json_.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

  friend class DequeElementRef<T>;
};

template <typename T>
class DequeElementRef {
 public:
  DequeElementRef(Deque<T>& owner, std::size_t index) : owner_(owner), index_(index) {}

  operator T() const {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_];
  }

  DequeElementRef& operator=(const T& value) {
    owner_.values_[index_] = value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

 private:
  Deque<T>& owner_;
  std::size_t index_;
};

template <typename T>
std::string to_json(const Deque<T>& values) {
  return to_json(values.raw());
}

template <typename T>
class Queue {
 public:
  Queue() : values_(), name_("queue"), path_prefix_json_(""), trace_(false) {}
  Queue(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Queue(const char* name, const char* field, int line) : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Queue(const std::deque<T>& values, const char* name, int line) : values_(values), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Queue(const std::deque<T>& values, const char* name, const char* field, int line) : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  T& front() {
    emit_read("front", values_.front(), current_trace_line());
    return values_.front();
  }

  const T& front() const {
    emit_read("front", values_.front(), current_trace_line());
    return values_.front();
  }

  T& back() {
    emit_read("back", values_.back(), current_trace_line());
    return values_.back();
  }

  const T& back() const {
    emit_read("back", values_.back(), current_trace_line());
    return values_.back();
  }

  void push(const T& value) {
    values_.push_back(value);
    emit_mutate("push", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void pop() {
    values_.pop_front();
    emit_mutate("pop", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  std::deque<T>& raw() { return values_; }
  const std::deque<T>& raw() const { return values_; }

  void emit_read(const char* slot, const T& value, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_slot(slot) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

 private:
  std::deque<T> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_slot(const char* slot) const {
    if (path_prefix_json_.empty()) {
      return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + to_json(slot) + "]}";
    }
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(slot) + "]}";
  }
};

template <typename T>
std::string to_json(const Queue<T>& values) {
  return to_json(values.raw());
}

template <typename T>
class PriorityQueue {
 public:
  PriorityQueue() : values_(), name_("priority_queue"), path_prefix_json_(""), trace_(false) {}
  PriorityQueue(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  PriorityQueue(const char* name, const char* field, int line) : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  PriorityQueue(const std::vector<T>& values, const char* name, int line) : values_(values.begin(), values.end()), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }
  PriorityQueue(const std::vector<T>& values, const char* name, const char* field, int line) : values_(values.begin(), values.end()), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  const T& top() const {
    emit_read("top", values_.top(), current_trace_line());
    return values_.top();
  }

  void push(const T& value) {
    values_.push(value);
    emit_mutate("push", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  template <typename... Args>
  void emplace(Args&&... args) {
    values_.emplace(std::forward<Args>(args)...);
    emit_mutate("emplace", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void pop() {
    values_.pop();
    emit_mutate("pop", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  std::vector<T> snapshot_values() const {
    auto copy = values_;
    std::vector<T> out;
    while (!copy.empty()) {
      out.push_back(copy.top());
      copy.pop();
    }
    return out;
  }

  void emit_read(const char* slot, const T& value, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_slot(slot) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(snapshot_values()) + "}",
      line
    );
  }

 private:
  std::priority_queue<T> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_slot(const char* slot) const {
    if (path_prefix_json_.empty()) {
      return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + to_json(slot) + "]}";
    }
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(slot) + "]}";
  }
};

template <typename T>
std::string to_json(const PriorityQueue<T>& values) {
  return to_json(values.snapshot_values());
}

template <typename T>
class Stack {
 public:
  Stack() : values_(), name_("stack"), path_prefix_json_(""), trace_(false) {}
  Stack(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Stack(const char* name, const char* field, int line) : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Stack(const std::deque<T>& values, const char* name, int line) : values_(values), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Stack(const std::deque<T>& values, const char* name, const char* field, int line) : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  T& top() {
    emit_read("top", values_.back(), current_trace_line());
    return values_.back();
  }

  const T& top() const {
    emit_read("top", values_.back(), current_trace_line());
    return values_.back();
  }

  void push(const T& value) {
    values_.push_back(value);
    emit_mutate("push", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void pop() {
    values_.pop_back();
    emit_mutate("pop", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  std::deque<T>& raw() { return values_; }
  const std::deque<T>& raw() const { return values_; }

  void emit_read(const char* slot, const T& value, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_slot(slot) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

 private:
  std::deque<T> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_slot(const char* slot) const {
    if (path_prefix_json_.empty()) {
      return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + to_json(slot) + "]}";
    }
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(slot) + "]}";
  }
};

template <typename T>
std::string to_json(const Stack<T>& values) {
  return to_json(values.raw());
}

template <typename K, typename V>
std::string to_json(const std::unordered_map<K, V>& values) {
  std::string json = "{";
  bool first = true;
  for (const auto& entry : values) {
    if (!first) json += ",";
    first = false;
    json += "\"" + to_json_key(entry.first) + "\":" + to_json(entry.second);
  }
  json += "}";
  return json;
}

template <typename K, typename V>
class UnorderedMapValueRef;

template <typename K, typename V>
class UnorderedMap {
 public:
  using key_type = K;
  using mapped_type = V;
  using iterator = typename std::unordered_map<K, V>::iterator;
  using const_iterator = typename std::unordered_map<K, V>::const_iterator;

  UnorderedMap() : values_(), name_("map"), path_prefix_json_(""), trace_(false) {}

  UnorderedMap(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(const char* name, const char* field, int line)
      : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(std::initializer_list<std::pair<const K, V>> values)
      : values_(values), name_("map"), path_prefix_json_(""), trace_(false) {}

  UnorderedMap(std::initializer_list<std::pair<const K, V>> values, const char* name, int line)
      : values_(values), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(std::initializer_list<std::pair<const K, V>> values, const char* name, const char* field, int line)
      : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(const std::unordered_map<K, V>& values, const char* name, const char* field, int line)
      : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap& operator=(const std::unordered_map<K, V>& values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  UnorderedMap& operator=(std::initializer_list<std::pair<const K, V>> values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  std::size_t count(const K& key) const {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.count(key);
  }

  bool contains(const K& key) const {
    return count(key) > 0;
  }

  iterator find(const K& key) {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.find(key);
  }

  const_iterator find(const K& key) const {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.find(key);
  }

  UnorderedMapValueRef<K, V> operator[](const K& key) {
    return UnorderedMapValueRef<K, V>(*this, key);
  }

  V at(const K& key) const {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.at(key);
  }

  std::pair<iterator, bool> insert(const std::pair<const K, V>& value) {
    auto result = values_.insert(value);
    if (result.second) {
      emit_write(value.first, result.first->second, current_trace_line());
    }
    return result;
  }

  template <typename... Args>
  std::pair<iterator, bool> emplace(Args&&... args) {
    auto result = values_.emplace(std::forward<Args>(args)...);
    if (result.second) {
      emit_write(result.first->first, result.first->second, current_trace_line());
    }
    return result;
  }

  std::size_t erase(const K& key) {
    const auto erased = values_.erase(key);
    if (erased > 0) {
      emit_mutate("erase", current_trace_line());
      emit_snapshot(current_trace_line());
    }
    return erased;
  }

  iterator erase(iterator position) {
    auto next = values_.erase(position);
    emit_mutate("erase", current_trace_line());
    emit_snapshot(current_trace_line());
    return next;
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  iterator begin() { return values_.begin(); }
  iterator end() { return values_.end(); }
  const_iterator begin() const { return values_.begin(); }
  const_iterator end() const { return values_.end(); }

  std::unordered_map<K, V>& raw() { return values_; }
  const std::unordered_map<K, V>& raw() const { return values_; }

  operator std::unordered_map<K, V>&() { return values_; }
  operator const std::unordered_map<K, V>&() const { return values_; }

  void emit_read(const K& key, int line, const std::string& value_json) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key) +
      ",\"value\":" + value_json + "}",
      line
    );
    if (!path_prefix_json_.empty()) emit_snapshot(line);
  }

  void emit_write(const K& key, const V& value, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_keyed_mutate(const K& key, const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key) +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

 private:
  std::unordered_map<K, V> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_key(const K& key) const {
    if (path_prefix_json_.empty()) return tracecode::target_json_key(name_, key);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(key) + "]}";
  }

  void emit_write_field(int line) {
    if (!trace_ || path_prefix_json_.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

  friend class UnorderedMapValueRef<K, V>;
};

template <typename K, typename V>
class UnorderedMapValueRef {
 public:
  UnorderedMapValueRef(UnorderedMap<K, V>& owner, K key) : owner_(owner), key_(key) {}

  operator V() const {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_[key_];
  }

  UnorderedMapValueRef& operator=(const V& value) {
    owner_.values_[key_] = value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  UnorderedMapValueRef& operator+=(const V& value) {
    owner_.values_[key_] += value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  UnorderedMapValueRef& operator++() {
    ++owner_.values_[key_];
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  V operator++(int) {
    V old = owner_.values_[key_]++;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return old;
  }

  template <typename U = V>
  std::enable_if_t<is_std_vector<U>::value, void>
  push_back(const typename U::value_type& value) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    owner_.values_[key_].push_back(value);
    owner_.emit_keyed_mutate(key_, "push_back", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
  }

 private:
  UnorderedMap<K, V>& owner_;
  K key_;
};

template <typename K, typename V>
std::string to_json(const UnorderedMapValueRef<K, V>& value) {
  V materialized = value;
  return to_json(materialized);
}

template <typename K, typename V>
std::string to_json(const UnorderedMap<K, V>& values) {
  return to_json(values.raw());
}

template <typename K, typename V>
class MapValueRef;

template <typename K, typename V>
class Map {
 public:
  using key_type = K;
  using mapped_type = V;
  using iterator = typename std::map<K, V>::iterator;
  using const_iterator = typename std::map<K, V>::const_iterator;

  Map() : values_(), name_("map"), path_prefix_json_(""), trace_(false) {}

  Map(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Map(const char* name, const char* field, int line)
      : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Map(std::initializer_list<std::pair<const K, V>> values) : values_(values), name_("map"), path_prefix_json_(""), trace_(false) {}

  Map(std::initializer_list<std::pair<const K, V>> values, const char* name, int line)
      : values_(values), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Map(std::initializer_list<std::pair<const K, V>> values, const char* name, const char* field, int line)
      : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Map(const std::map<K, V>& values, const char* name, const char* field, int line)
      : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Map& operator=(const std::map<K, V>& values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Map& operator=(std::initializer_list<std::pair<const K, V>> values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  std::size_t count(const K& key) const {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.count(key);
  }

  bool contains(const K& key) const {
    return count(key) > 0;
  }

  iterator find(const K& key) {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.find(key);
  }

  const_iterator find(const K& key) const {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.find(key);
  }

  MapValueRef<K, V> operator[](const K& key) {
    return MapValueRef<K, V>(*this, key);
  }

  V at(const K& key) const {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.at(key);
  }

  std::pair<iterator, bool> insert(const std::pair<const K, V>& value) {
    auto result = values_.insert(value);
    if (result.second) {
      emit_write(value.first, result.first->second, current_trace_line());
    }
    return result;
  }

  template <typename... Args>
  std::pair<iterator, bool> emplace(Args&&... args) {
    auto result = values_.emplace(std::forward<Args>(args)...);
    if (result.second) {
      emit_write(result.first->first, result.first->second, current_trace_line());
    }
    return result;
  }

  std::size_t erase(const K& key) {
    const auto erased = values_.erase(key);
    if (erased > 0) {
      emit_mutate("erase", current_trace_line());
      emit_snapshot(current_trace_line());
    }
    return erased;
  }

  iterator erase(iterator position) {
    auto next = values_.erase(position);
    emit_mutate("erase", current_trace_line());
    emit_snapshot(current_trace_line());
    return next;
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  iterator begin() { return values_.begin(); }
  iterator end() { return values_.end(); }
  const_iterator begin() const { return values_.begin(); }
  const_iterator end() const { return values_.end(); }

  std::map<K, V>& raw() { return values_; }
  const std::map<K, V>& raw() const { return values_; }

  operator std::map<K, V>&() { return values_; }
  operator const std::map<K, V>&() const { return values_; }

  void emit_read(const K& key, int line, const std::string& value_json) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key) +
      ",\"value\":" + value_json + "}",
      line
    );
    if (!path_prefix_json_.empty()) emit_snapshot(line);
  }

  void emit_write(const K& key, const V& value, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

 private:
  std::map<K, V> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_key(const K& key) const {
    if (path_prefix_json_.empty()) return tracecode::target_json_key(name_, key);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(key) + "]}";
  }

  void emit_write_field(int line) {
    if (!trace_ || path_prefix_json_.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

  friend class MapValueRef<K, V>;
};

template <typename K, typename V>
class MapValueRef {
 public:
  MapValueRef(Map<K, V>& owner, K key) : owner_(owner), key_(key) {}

  operator V() const {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_[key_];
  }

  MapValueRef& operator=(const V& value) {
    owner_.values_[key_] = value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  MapValueRef& operator+=(const V& value) {
    owner_.values_[key_] += value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  MapValueRef& operator++() {
    ++owner_.values_[key_];
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  V operator++(int) {
    V old = owner_.values_[key_]++;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return old;
  }

 private:
  Map<K, V>& owner_;
  K key_;
};

template <typename K, typename V>
std::string to_json(const Map<K, V>& values) {
  return to_json(values.raw());
}

template <typename K, typename V>
std::string to_json(const MapValueRef<K, V>& value) {
  V materialized = value;
  return to_json(materialized);
}

template <typename K, typename V>
std::string to_json(const std::map<K, V>& values) {
  std::string json = "{";
  bool first = true;
  for (const auto& entry : values) {
    if (!first) json += ",";
    first = false;
    json += "\"" + to_json_key(entry.first) + "\":" + to_json(entry.second);
  }
  json += "}";
  return json;
}

template <typename T>
class Set {
 public:
  using iterator = typename std::set<T>::iterator;
  using const_iterator = typename std::set<T>::const_iterator;

  Set() : values_(), name_("set"), path_prefix_json_(""), trace_(false) {}
  Set(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Set(const char* name, const char* field, int line) : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Set(std::initializer_list<T> values) : values_(values), name_("set"), path_prefix_json_(""), trace_(false) {}
  Set(std::initializer_list<T> values, const char* name, int line) : values_(values), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Set(std::initializer_list<T> values, const char* name, const char* field, int line) : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Set(const std::set<T>& values, const char* name, const char* field, int line) : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  Set& operator=(const std::set<T>& values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Set& operator=(std::initializer_list<T> values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  std::size_t count(const T& value) const {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, current_trace_line());
    return values_.count(value);
  }

  bool contains(const T& value) const {
    return count(value) > 0;
  }

  iterator find(const T& value) {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, current_trace_line());
    return values_.find(value);
  }

  const_iterator find(const T& value) const {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, current_trace_line());
    return values_.find(value);
  }

  std::pair<iterator, bool> insert(const T& value) {
    auto result = values_.insert(value);
    if (result.second) emit_write(value, current_trace_line());
    return result;
  }

  template <typename... Args>
  std::pair<iterator, bool> emplace(Args&&... args) {
    auto result = values_.emplace(std::forward<Args>(args)...);
    if (result.second) emit_write(*result.first, current_trace_line());
    return result;
  }

  std::size_t erase(const T& value) {
    const auto erased = values_.erase(value);
    if (erased > 0) {
      emit_mutate("erase", current_trace_line());
      emit_snapshot(current_trace_line());
    }
    return erased;
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  iterator begin() { return values_.begin(); }
  iterator end() { return values_.end(); }
  const_iterator begin() const { return values_.begin(); }
  const_iterator end() const { return values_.end(); }

  std::set<T>& raw() { return values_; }
  const std::set<T>& raw() const { return values_; }
  operator std::set<T>&() { return values_; }
  operator const std::set<T>&() const { return values_; }

  void emit_read(const T& value, bool present, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(value) +
      ",\"value\":" + to_json(present) + "}",
      line
    );
    if (!path_prefix_json_.empty()) emit_snapshot(line);
  }

  void emit_write(const T& value, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(value) +
      ",\"value\":true}",
      line
    );
    emit_snapshot(line);
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

 private:
  std::set<T> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_key(const T& value) const {
    if (path_prefix_json_.empty()) return tracecode::target_json_key(name_, value);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(value) + "]}";
  }

  void emit_write_field(int line) {
    if (!trace_ || path_prefix_json_.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }
};

template <typename T>
std::string to_json(const std::set<T>& values) {
  std::string json = "[";
  bool first = true;
  for (const auto& value : values) {
    if (!first) json += ",";
    first = false;
    json += to_json(value);
  }
  json += "]";
  return json;
}

template <typename T>
std::string to_json(const Set<T>& values) {
  return to_json(values.raw());
}

template <typename T>
class UnorderedSet {
 public:
  using iterator = typename std::unordered_set<T>::iterator;
  using const_iterator = typename std::unordered_set<T>::const_iterator;

  UnorderedSet() : values_(), name_("set"), path_prefix_json_(""), trace_(false) {}
  UnorderedSet(const char* name, int line) : values_(), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  UnorderedSet(const char* name, const char* field, int line) : values_(), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  UnorderedSet(std::initializer_list<T> values) : values_(values), name_("set"), path_prefix_json_(""), trace_(false) {}
  UnorderedSet(std::initializer_list<T> values, const char* name, int line) : values_(values), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  UnorderedSet(std::initializer_list<T> values, const char* name, const char* field, int line) : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  UnorderedSet(const std::unordered_set<T>& values, const char* name, const char* field, int line) : values_(values), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  UnorderedSet& operator=(const std::unordered_set<T>& values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  UnorderedSet& operator=(std::initializer_list<T> values) {
    values_ = values;
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  std::size_t count(const T& value) const {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, current_trace_line());
    return values_.count(value);
  }

  bool contains(const T& value) const {
    return count(value) > 0;
  }

  iterator find(const T& value) {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, current_trace_line());
    return values_.find(value);
  }

  const_iterator find(const T& value) const {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, current_trace_line());
    return values_.find(value);
  }

  std::pair<iterator, bool> insert(const T& value) {
    auto result = values_.insert(value);
    if (result.second) emit_write(value, current_trace_line());
    return result;
  }

  template <typename... Args>
  std::pair<iterator, bool> emplace(Args&&... args) {
    auto result = values_.emplace(std::forward<Args>(args)...);
    if (result.second) emit_write(*result.first, current_trace_line());
    return result;
  }

  std::size_t erase(const T& value) {
    const auto erased = values_.erase(value);
    if (erased > 0) {
      emit_mutate("erase", current_trace_line());
      emit_snapshot(current_trace_line());
    }
    return erased;
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  iterator begin() { return values_.begin(); }
  iterator end() { return values_.end(); }
  const_iterator begin() const { return values_.begin(); }
  const_iterator end() const { return values_.end(); }

  std::unordered_set<T>& raw() { return values_; }
  const std::unordered_set<T>& raw() const { return values_; }
  operator std::unordered_set<T>&() { return values_; }
  operator const std::unordered_set<T>&() const { return values_; }

  void emit_read(const T& value, bool present, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(value) +
      ",\"value\":" + to_json(present) + "}",
      line
    );
    if (!path_prefix_json_.empty()) emit_snapshot(line);
  }

  void emit_write(const T& value, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(value) +
      ",\"value\":true}",
      line
    );
    emit_snapshot(line);
  }

  void emit_mutate(const char* method, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) + "}",
      line
    );
  }

  void emit_snapshot(int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

 private:
  std::unordered_set<T> values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_key(const T& value) const {
    if (path_prefix_json_.empty()) return tracecode::target_json_key(name_, value);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(value) + "]}";
  }

  void emit_write_field(int line) {
    if (!trace_ || path_prefix_json_.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }
};

template <typename T>
std::string to_json(const std::unordered_set<T>& values) {
  std::string json = "[";
  bool first = true;
  for (const auto& value : values) {
    if (!first) json += ",";
    first = false;
    json += to_json(value);
  }
  json += "]";
  return json;
}

template <typename T>
std::string to_json(const UnorderedSet<T>& values) {
  return to_json(values.raw());
}

template <typename T>
void write_result_json(const T& value) {
  std::string json = std::string("__TRACECODE_RESULT__") + to_json(value) + "\n";
  std::fputs(json.c_str(), stdout);
}

inline void write_result_json_raw(const std::string& value_json) {
  std::string json = std::string("__TRACECODE_RESULT__") + value_json + "\n";
  std::fputs(json.c_str(), stdout);
}

inline void write_trace_event_json_raw(const std::string& event_json) {
  std::string json = std::string("__TRACECODE_EVENT__") + event_json + "\n";
  std::fputs(json.c_str(), stdout);
}

inline void configure_trace_budget(int max_events) {
  trace_event_count() = 0;
  trace_budget_exceeded() = false;
  trace_event_budget() = max_events > 0 ? max_events : 10000;
}

inline void stop_for_trace_budget(int line) {
  if (trace_budget_exceeded()) {
    std::exit(124);
  }
  trace_budget_exceeded() = true;
  write_trace_event_json_raw(
    std::string("{\"kind\":\"timeout\",\"line\":") + std::to_string(line) +
    ",\"message\":\"C++ trace budget exceeded\"}"
  );
  std::fflush(stdout);
  std::exit(124);
}

inline void check_trace_budget(int line) {
  if (trace_event_count() >= trace_event_budget()) {
    stop_for_trace_budget(line);
  }
}

inline void write_trace_event_json(const std::string& event_json, int line) {
  check_trace_budget(line);
  trace_event_count() += 1;
  write_trace_event_json_raw(event_json);
}

inline void set_current_trace_line(int line) {
  current_trace_line() = line;
}

inline void emit_post_line_frame(int line, const char* function_name) {
  set_current_trace_line(line);
  write_trace_event_json(
    std::string("{\"kind\":\"line\",\"line\":") + std::to_string(line) +
    ",\"function\":" + to_json(function_name) + "}",
    line
  );
}

inline void emit_line(int line, const char* function_name) {
  emit_post_line_frame(line, function_name);
}

struct TraceHooks {
  static void setCurrentLine(int line) {
    set_current_trace_line(line);
  }

  static void emitPostLineFrame(int line, const char* function_name) {
    emit_post_line_frame(line, function_name);
  }

  static void recordRawEvent(const std::string& event_json, int line) {
    write_trace_event_json(event_json, line);
  }

  template <typename T>
  static void recordSnapshot(const std::string& name, const T& value, int line) {
    emit_snapshot_value(name, value, line);
  }

  static void flushCompletedLine(int line, const char* function_name) {
    emitPostLineFrame(line, function_name);
  }
};

}  // namespace tracecode
