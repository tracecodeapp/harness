#pragma once

#include <any>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <cstdio>
#include <deque>
#include <iomanip>
#include <iterator>
#include <limits>
#include <map>
#include <optional>
#include <queue>
#include <set>
#include <stack>
#include <sstream>
#include <string>
#include <type_traits>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

namespace tracecode {

template <typename T, typename = void>
struct HasTraceNameAccessors : std::false_type {};

template <typename T>
struct HasTraceNameAccessors<
    T,
    std::void_t<
        decltype(std::declval<const T&>().trace_name()),
        decltype(std::declval<T&>().set_trace_name(std::declval<const char*>()))>> : std::true_type {};

template <typename T>
class ScopedTraceName {
 public:
  ScopedTraceName(T& value, const char* name) : value_(value) {
    if constexpr (HasTraceNameAccessors<T>::value) {
      previous_ = value_.trace_name();
      value_.set_trace_name(name);
    }
  }

  ScopedTraceName(const ScopedTraceName&) = delete;
  ScopedTraceName& operator=(const ScopedTraceName&) = delete;

  ~ScopedTraceName() {
    if constexpr (HasTraceNameAccessors<T>::value) {
      value_.set_trace_name(previous_.c_str());
    }
  }

 private:
  T& value_;
  std::string previous_;
};

template <typename T>
ScopedTraceName<T> scoped_trace_name(T& value, const char* name) {
  return ScopedTraceName<T>(value, name);
}

inline int& trace_event_count() {
  static int value = 0;
  return value;
}

inline int& trace_event_budget() {
  static int value = 10000;
  return value;
}

inline int& trace_line_event_count() {
  static int value = 0;
  return value;
}

inline int& trace_line_event_budget() {
  static int value = 0;
  return value;
}

inline int& trace_single_line_hit_budget() {
  static int value = 0;
  return value;
}

inline std::map<int, int>& trace_line_hit_counts() {
  static std::map<int, int> value;
  return value;
}

inline bool& trace_budget_exceeded() {
  static bool value = false;
  return value;
}

inline std::string& trace_budget_timeout_reason() {
  static std::string value = "";
  return value;
}

inline int& dropped_trace_event_count() {
  static int value = 0;
  return value;
}

inline bool& hard_stop_on_trace_budget() {
  static bool value = false;
  return value;
}

inline bool& minimal_trace_enabled() {
  static bool value = false;
  return value;
}

inline int& current_trace_line() {
  static int value = 1;
  return value;
}

inline int& scoped_trace_line() {
  static int value = 0;
  return value;
}

inline int trace_event_line() {
  return scoped_trace_line() > 0 ? scoped_trace_line() : current_trace_line();
}

struct TraceLineScope {
  int previous;

  explicit TraceLineScope(int line) : previous(current_trace_line()) {
    current_trace_line() = line;
  }

  ~TraceLineScope() {
    current_trace_line() = previous;
  }
};

template <typename Fn>
inline auto with_trace_line(int line, Fn&& fn) -> decltype(fn()) {
  TraceLineScope scope(line);
  return fn();
}

struct ScopedTraceLineScope {
  int previous;

  explicit ScopedTraceLineScope(int line) : previous(scoped_trace_line()) {
    scoped_trace_line() = line;
  }

  ~ScopedTraceLineScope() {
    scoped_trace_line() = previous;
  }
};

template <typename Fn>
inline auto with_scoped_trace_line(int line, Fn&& fn) -> decltype(fn()) {
  TraceLineScope line_scope(line);
  ScopedTraceLineScope scoped_line_scope(line);
  return fn();
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

struct JsonValue {
  enum class Kind { Null, Bool, Number, String, Array, Object };

  Kind kind = Kind::Null;
  bool bool_value = false;
  double number_value = 0;
  std::string string_value;
  std::vector<JsonValue> array_values;
  std::vector<std::pair<std::string, JsonValue>> object_values;

  bool is_null() const { return kind == Kind::Null; }
};

[[noreturn]] inline void json_error(const std::string& message) {
  std::fputs(message.c_str(), stderr);
  std::fputc('\n', stderr);
  std::abort();
}

class JsonParser {
 public:
  explicit JsonParser(std::string source) : source_(std::move(source)) {}

  JsonValue parse() {
    skip_whitespace();
    JsonValue value = parse_value();
    skip_whitespace();
    if (position_ != source_.size()) {
      json_error("Unexpected trailing JSON input.");
    }
    return value;
  }

 private:
  std::string source_;
  std::size_t position_ = 0;

  char peek() const {
    return position_ < source_.size() ? source_[position_] : '\0';
  }

  char take() {
    if (position_ >= source_.size()) {
      json_error("Unexpected end of JSON input.");
    }
    return source_[position_++];
  }

  void skip_whitespace() {
    while (position_ < source_.size() && std::isspace(static_cast<unsigned char>(source_[position_]))) {
      position_ += 1;
    }
  }

  void expect(char expected) {
    char actual = take();
    if (actual != expected) {
      json_error("Unexpected JSON character.");
    }
  }

  bool consume_literal(const char* literal) {
    std::size_t cursor = position_;
    for (const char* item = literal; *item; ++item) {
      if (cursor >= source_.size() || source_[cursor] != *item) return false;
      cursor += 1;
    }
    position_ = cursor;
    return true;
  }

  JsonValue parse_value() {
    skip_whitespace();
    const char ch = peek();
    if (ch == '"') return parse_string_value();
    if (ch == '[') return parse_array();
    if (ch == '{') return parse_object();
    if (ch == '-' || (ch >= '0' && ch <= '9')) return parse_number();
    if (consume_literal("true")) {
      JsonValue value;
      value.kind = JsonValue::Kind::Bool;
      value.bool_value = true;
      return value;
    }
    if (consume_literal("false")) {
      JsonValue value;
      value.kind = JsonValue::Kind::Bool;
      value.bool_value = false;
      return value;
    }
    if (consume_literal("null")) {
      return JsonValue{};
    }
    json_error("Invalid JSON value.");
  }

  JsonValue parse_string_value() {
    JsonValue value;
    value.kind = JsonValue::Kind::String;
    value.string_value = parse_string();
    return value;
  }

  std::string parse_string() {
    expect('"');
    std::string out;
    while (true) {
      char ch = take();
      if (ch == '"') return out;
      if (ch != '\\') {
        out += ch;
        continue;
      }

      char escaped = take();
      switch (escaped) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u':
          for (int index = 0; index < 4; ++index) {
            take();
          }
          out += '?';
          break;
        default:
          json_error("Invalid JSON string escape.");
      }
    }
  }

  JsonValue parse_number() {
    const char* start = source_.c_str() + position_;
    char* end = nullptr;
    double number = std::strtod(start, &end);
    if (end == start) {
      json_error("Invalid JSON number.");
    }
    position_ += static_cast<std::size_t>(end - start);
    JsonValue value;
    value.kind = JsonValue::Kind::Number;
    value.number_value = number;
    return value;
  }

  JsonValue parse_array() {
    JsonValue value;
    value.kind = JsonValue::Kind::Array;
    expect('[');
    skip_whitespace();
    if (peek() == ']') {
      take();
      return value;
    }
    while (true) {
      value.array_values.push_back(parse_value());
      skip_whitespace();
      char separator = take();
      if (separator == ']') return value;
      if (separator != ',') json_error("Invalid JSON array.");
    }
  }

  JsonValue parse_object() {
    JsonValue value;
    value.kind = JsonValue::Kind::Object;
    expect('{');
    skip_whitespace();
    if (peek() == '}') {
      take();
      return value;
    }
    while (true) {
      skip_whitespace();
      std::string key = parse_string();
      skip_whitespace();
      expect(':');
      value.object_values.push_back({key, parse_value()});
      skip_whitespace();
      char separator = take();
      if (separator == '}') return value;
      if (separator != ',') json_error("Invalid JSON object.");
    }
  }
};

inline std::string read_stdin_all() {
  std::string input;
  int ch = 0;
  while ((ch = std::getchar()) != EOF) {
    input += static_cast<char>(ch);
  }
  return input;
}

inline JsonValue parse_json(const std::string& source) {
  return JsonParser(source.empty() ? "{}" : source).parse();
}

inline std::string to_json(const JsonValue& value);

inline const JsonValue* object_get(const JsonValue& value, const std::string& key) {
  if (value.kind != JsonValue::Kind::Object) return nullptr;
  for (const auto& entry : value.object_values) {
    if (entry.first == key) return &entry.second;
  }
  return nullptr;
}

inline const std::string* object_get_string(const JsonValue& value, const std::string& key) {
  const JsonValue* item = object_get(value, key);
  if (item && item->kind == JsonValue::Kind::String) return &item->string_value;
  return nullptr;
}

inline const JsonValue& json_input_value(const JsonValue& root, const std::string& name, std::size_t index) {
  if (const JsonValue* named = object_get(root, name)) return *named;
  if (root.kind == JsonValue::Kind::Object && index < root.object_values.size()) {
    return root.object_values[index].second;
  }
  json_error("Missing C++ input value: " + name);
}

template <typename T>
struct json_is_std_vector : std::false_type {};
template <typename T, typename Allocator>
struct json_is_std_vector<std::vector<T, Allocator>> : std::true_type {};

template <typename T>
struct json_is_std_deque : std::false_type {};
template <typename T, typename Allocator>
struct json_is_std_deque<std::deque<T, Allocator>> : std::true_type {};

template <typename T>
struct json_is_std_array : std::false_type {};
template <typename T, std::size_t Size>
struct json_is_std_array<std::array<T, Size>> : std::true_type {};

template <typename T>
struct json_is_std_queue : std::false_type {};
template <typename T, typename Container>
struct json_is_std_queue<std::queue<T, Container>> : std::true_type {};

template <typename T>
struct json_is_std_stack : std::false_type {};
template <typename T, typename Container>
struct json_is_std_stack<std::stack<T, Container>> : std::true_type {};

template <typename T>
struct json_is_std_priority_queue : std::false_type {};
template <typename T, typename Container, typename Compare>
struct json_is_std_priority_queue<std::priority_queue<T, Container, Compare>> : std::true_type {};

template <typename T>
struct json_is_std_map : std::false_type {};
template <typename K, typename V, typename Compare, typename Allocator>
struct json_is_std_map<std::map<K, V, Compare, Allocator>> : std::true_type {};

template <typename T>
struct json_is_std_unordered_map : std::false_type {};
template <typename K, typename V, typename Hash, typename Equal, typename Allocator>
struct json_is_std_unordered_map<std::unordered_map<K, V, Hash, Equal, Allocator>> : std::true_type {};

template <typename T>
struct json_is_std_set : std::false_type {};
template <typename K, typename Compare, typename Allocator>
struct json_is_std_set<std::set<K, Compare, Allocator>> : std::true_type {};

template <typename T>
struct json_is_std_unordered_set : std::false_type {};
template <typename K, typename Hash, typename Equal, typename Allocator>
struct json_is_std_unordered_set<std::unordered_set<K, Hash, Equal, Allocator>> : std::true_type {};

template <typename T>
struct json_is_std_pair : std::false_type {};
template <typename A, typename B>
struct json_is_std_pair<std::pair<A, B>> : std::true_type {};

template <typename T>
struct json_is_std_tuple : std::false_type {};
template <typename... Values>
struct json_is_std_tuple<std::tuple<Values...>> : std::true_type {};

template <typename T>
T json_to(const JsonValue& value);

template <typename Node>
Node* json_to_tree_node(const JsonValue& value);

template <typename Node>
Node* json_to_list_node(const JsonValue& value);

template <typename Node, typename = void>
struct json_has_tree_node_shape : std::false_type {};
template <typename Node>
struct json_has_tree_node_shape<Node, std::void_t<decltype(std::declval<Node>().val), decltype(std::declval<Node>().left), decltype(std::declval<Node>().right)>> : std::true_type {};

template <typename Node, typename = void>
struct json_has_list_node_shape : std::false_type {};
template <typename Node>
struct json_has_list_node_shape<Node, std::void_t<decltype(std::declval<Node>().val), decltype(std::declval<Node>().next)>> : std::true_type {};

template <typename Node, typename = void>
struct json_has_member_val : std::false_type {};
template <typename Node>
struct json_has_member_val<Node, std::void_t<decltype(std::declval<Node>().val)>> : std::true_type {};

template <typename Node, typename = void>
struct json_has_member_is_end : std::false_type {};
template <typename Node>
struct json_has_member_is_end<Node, std::void_t<decltype(std::declval<Node>().isEnd)>> : std::true_type {};

template <typename Node, typename = void>
struct json_has_member_index : std::false_type {};
template <typename Node>
struct json_has_member_index<Node, std::void_t<decltype(std::declval<Node>().index)>> : std::true_type {};

template <typename Node, typename = void>
struct json_has_member_word : std::false_type {};
template <typename Node>
struct json_has_member_word<Node, std::void_t<decltype(std::declval<Node>().word)>> : std::true_type {};

template <typename K>
K json_key_to(const std::string& key) {
  if constexpr (std::is_same_v<K, std::string>) {
    return key;
  } else if constexpr (std::is_integral_v<K> && !std::is_same_v<K, bool>) {
    return static_cast<K>(std::strtoll(key.c_str(), nullptr, 10));
  } else if constexpr (std::is_floating_point_v<K>) {
    return static_cast<K>(std::strtod(key.c_str(), nullptr));
  } else {
    return K(key);
  }
}

template <typename Tuple, std::size_t... Indices>
Tuple json_to_tuple(const JsonValue& value, std::index_sequence<Indices...>) {
  if (value.kind != JsonValue::Kind::Array) {
    json_error("Expected JSON array for tuple input.");
  }
  return Tuple{json_to<std::tuple_element_t<Indices, Tuple>>(value.array_values.at(Indices))...};
}

template <typename T>
T json_to(const JsonValue& value) {
  using D = std::decay_t<T>;
  if constexpr (std::is_same_v<D, bool>) {
    if (value.kind == JsonValue::Kind::Bool) return value.bool_value;
    if (value.kind == JsonValue::Kind::Number) return value.number_value != 0;
    return false;
  } else if constexpr (std::is_integral_v<D> && !std::is_same_v<D, bool> && !std::is_same_v<D, char>) {
    return static_cast<D>(value.kind == JsonValue::Kind::Number ? value.number_value : 0);
  } else if constexpr (std::is_same_v<D, char>) {
    return value.kind == JsonValue::Kind::String && !value.string_value.empty() ? value.string_value[0] : '\0';
  } else if constexpr (std::is_floating_point_v<D>) {
    return static_cast<D>(value.kind == JsonValue::Kind::Number ? value.number_value : 0);
  } else if constexpr (std::is_same_v<D, std::string>) {
    if (value.kind == JsonValue::Kind::String) return value.string_value;
    if (value.kind == JsonValue::Kind::Number) return std::to_string(value.number_value);
    if (value.kind == JsonValue::Kind::Bool) return value.bool_value ? "true" : "false";
    return "";
  } else if constexpr (std::is_same_v<D, std::any>) {
    if (value.kind == JsonValue::Kind::Null) return std::any{};
    if (value.kind == JsonValue::Kind::Bool) return std::any(value.bool_value);
    if (value.kind == JsonValue::Kind::Number) {
      double rounded = std::round(value.number_value);
      if (std::fabs(value.number_value - rounded) < 1e-9) {
        return std::any(static_cast<long long>(rounded));
      }
      return std::any(value.number_value);
    }
    if (value.kind == JsonValue::Kind::String) return std::any(value.string_value);
    if (value.kind == JsonValue::Kind::Array) {
      std::vector<std::any> out;
      out.reserve(value.array_values.size());
      for (const auto& item : value.array_values) out.push_back(json_to<std::any>(item));
      return std::any(out);
    }
    std::map<std::string, std::any> out;
    for (const auto& entry : value.object_values) out[entry.first] = json_to<std::any>(entry.second);
    return std::any(out);
  } else if constexpr (std::is_same_v<D, JsonValue>) {
    return value;
  } else if constexpr (std::is_pointer_v<D> && json_has_tree_node_shape<std::remove_pointer_t<D>>::value) {
    return json_to_tree_node<std::remove_pointer_t<D>>(value);
  } else if constexpr (std::is_pointer_v<D> && json_has_list_node_shape<std::remove_pointer_t<D>>::value) {
    return json_to_list_node<std::remove_pointer_t<D>>(value);
  } else if constexpr (json_is_std_vector<D>::value) {
    D out;
    if (value.kind != JsonValue::Kind::Array) return out;
    for (const auto& item : value.array_values) out.push_back(json_to<typename D::value_type>(item));
    return out;
  } else if constexpr (json_is_std_deque<D>::value) {
    D out;
    if (value.kind != JsonValue::Kind::Array) return out;
    for (const auto& item : value.array_values) out.push_back(json_to<typename D::value_type>(item));
    return out;
  } else if constexpr (json_is_std_array<D>::value) {
    D out{};
    if (value.kind != JsonValue::Kind::Array) return out;
    for (std::size_t index = 0; index < out.size() && index < value.array_values.size(); ++index) {
      out[index] = json_to<typename D::value_type>(value.array_values[index]);
    }
    return out;
  } else if constexpr (json_is_std_queue<D>::value) {
    D out;
    if (value.kind != JsonValue::Kind::Array) return out;
    for (const auto& item : value.array_values) out.push(json_to<typename D::value_type>(item));
    return out;
  } else if constexpr (json_is_std_stack<D>::value) {
    D out;
    if (value.kind != JsonValue::Kind::Array) return out;
    for (const auto& item : value.array_values) out.push(json_to<typename D::value_type>(item));
    return out;
  } else if constexpr (json_is_std_priority_queue<D>::value) {
    D out;
    if (value.kind != JsonValue::Kind::Array) return out;
    for (const auto& item : value.array_values) out.push(json_to<typename D::value_type>(item));
    return out;
  } else if constexpr (json_is_std_map<D>::value || json_is_std_unordered_map<D>::value) {
    D out;
    if (value.kind != JsonValue::Kind::Object) return out;
    for (const auto& entry : value.object_values) {
      out[json_key_to<typename D::key_type>(entry.first)] = json_to<typename D::mapped_type>(entry.second);
    }
    return out;
  } else if constexpr (json_is_std_set<D>::value || json_is_std_unordered_set<D>::value) {
    D out;
    if (value.kind != JsonValue::Kind::Array) return out;
    for (const auto& item : value.array_values) out.insert(json_to<typename D::value_type>(item));
    return out;
  } else if constexpr (json_is_std_pair<D>::value) {
    if (value.kind != JsonValue::Kind::Array || value.array_values.size() < 2) return D{};
    return D{json_to<typename D::first_type>(value.array_values[0]), json_to<typename D::second_type>(value.array_values[1])};
  } else if constexpr (json_is_std_tuple<D>::value) {
    return json_to_tuple<D>(value, std::make_index_sequence<std::tuple_size_v<D>>{});
  } else {
    return D{};
  }
}

template <typename T>
T read_json_input(const JsonValue& root, const std::string& name, std::size_t index) {
  return json_to<T>(json_input_value(root, name, index));
}

template <typename Node>
Node* json_to_tree_node_impl(const JsonValue& value, std::map<std::string, Node*>& refs) {
  if (value.is_null()) return nullptr;
  if (value.kind == JsonValue::Kind::Array) {
    if (value.array_values.empty() || value.array_values[0].is_null()) return nullptr;
    std::vector<Node*> nodes;
    nodes.reserve(value.array_values.size());
    for (const auto& item : value.array_values) {
      nodes.push_back(item.is_null() ? nullptr : new Node(json_to<int>(item)));
    }
    for (std::size_t index = 0, child = 1; child < nodes.size(); ++index) {
      if (!nodes[index]) continue;
      if (child < nodes.size()) nodes[index]->left = nodes[child++];
      if (child < nodes.size()) nodes[index]->right = nodes[child++];
    }
    return nodes[0];
  }
  if (value.kind != JsonValue::Kind::Object) return nullptr;
  if (const std::string* ref = object_get_string(value, "__ref__")) {
    const auto found = refs.find(*ref);
    return found == refs.end() ? nullptr : found->second;
  }
  const JsonValue* val = object_get(value, "val");
  if (!val) val = object_get(value, "value");
  Node* node = new Node(val ? json_to<int>(*val) : 0);
  if (const std::string* id = object_get_string(value, "__id__")) refs[*id] = node;
  if (const JsonValue* left = object_get(value, "left")) node->left = json_to_tree_node_impl<Node>(*left, refs);
  if (const JsonValue* right = object_get(value, "right")) node->right = json_to_tree_node_impl<Node>(*right, refs);
  return node;
}

template <typename Node>
Node* json_to_tree_node(const JsonValue& value) {
  std::map<std::string, Node*> refs;
  return json_to_tree_node_impl<Node>(value, refs);
}

template <typename Node>
Node* json_to_list_node_impl(const JsonValue& value, std::map<std::string, Node*>& refs) {
  if (value.is_null()) return nullptr;
  if (value.kind == JsonValue::Kind::Array) {
    Node* head = nullptr;
    Node* tail = nullptr;
    for (const auto& item : value.array_values) {
      Node* node = new Node(json_to<int>(item));
      if (!head) head = node;
      else tail->next = node;
      tail = node;
    }
    return head;
  }
  if (value.kind != JsonValue::Kind::Object) return nullptr;
  if (const std::string* ref = object_get_string(value, "__ref__")) {
    const auto found = refs.find(*ref);
    return found == refs.end() ? nullptr : found->second;
  }
  const JsonValue* val = object_get(value, "val");
  if (!val) val = object_get(value, "value");
  Node* node = new Node(val ? json_to<int>(*val) : 0);
  if (const std::string* id = object_get_string(value, "__id__")) refs[*id] = node;
  if (const JsonValue* next = object_get(value, "next")) node->next = json_to_list_node_impl<Node>(*next, refs);
  return node;
}

template <typename Node>
Node* json_to_list_node(const JsonValue& value) {
  std::map<std::string, Node*> refs;
  return json_to_list_node_impl<Node>(value, refs);
}

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
    } else if (static_cast<unsigned char>(ch) < 0x20) {
      constexpr char hex[] = "0123456789abcdef";
      unsigned char value = static_cast<unsigned char>(ch);
      escaped += "\\u00";
      escaped += hex[(value >> 4) & 0x0f];
      escaped += hex[value & 0x0f];
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

inline std::string no_arg_mutation_args_json(const char* method) {
  if (method == nullptr) return "";
  std::string name(method);
  if (
    name == "clear" ||
    name == "pop" ||
    name == "pop_back" ||
    name == "pop_front"
  ) {
    return ",\"args\":[]";
  }
  return "";
}

inline std::string to_json(char value) {
  return to_json(std::string(1, value));
}

inline std::string to_json(bool value) {
  return value ? "true" : "false";
}

inline std::string to_json(std::nullptr_t) {
  return "null";
}

template <typename T>
std::string finite_number_to_json(T value) {
  std::ostringstream out;
  out << std::setprecision(std::numeric_limits<T>::max_digits10) << value;
  return out.str();
}

inline std::string to_json(const JsonValue& value) {
  switch (value.kind) {
    case JsonValue::Kind::Null:
      return "null";
    case JsonValue::Kind::Bool:
      return value.bool_value ? "true" : "false";
    case JsonValue::Kind::Number: {
      double rounded = std::round(value.number_value);
      if (std::fabs(value.number_value - rounded) < 1e-9) return std::to_string(static_cast<long long>(rounded));
      return finite_number_to_json(value.number_value);
    }
    case JsonValue::Kind::String:
      return to_json(value.string_value);
    case JsonValue::Kind::Array: {
      std::string json = "[";
      for (std::size_t index = 0; index < value.array_values.size(); ++index) {
        if (index > 0) json += ",";
        json += to_json(value.array_values[index]);
      }
      json += "]";
      return json;
    }
    case JsonValue::Kind::Object: {
      std::string json = "{";
      for (std::size_t index = 0; index < value.object_values.size(); ++index) {
        if (index > 0) json += ",";
        json += to_json(value.object_values[index].first);
        json += ":";
        json += to_json(value.object_values[index].second);
      }
      json += "}";
      return json;
    }
  }
  return "null";
}

template <typename T>
std::enable_if_t<std::is_arithmetic_v<T> && !std::is_same_v<T, bool>, std::string>
to_json(T value) {
  if constexpr (std::is_floating_point_v<T>) {
    if (std::isnan(value)) return "null";
    if (!std::isfinite(value)) return value < 0 ? "-1.7976931348623157e308" : "1.7976931348623157e308";
    return finite_number_to_json(value);
  }
  return std::to_string(value);
}

inline std::string tracecode_ref_id(std::unordered_map<const void*, std::string>& refs) {
  return std::string("ref-") + std::to_string(refs.size());
}

inline std::string tracecode_pointer_ref_id(const void* ptr) {
  std::ostringstream stream;
  stream << "ptr-" << reinterpret_cast<std::uintptr_t>(ptr);
  return stream.str();
}

inline std::string to_json_tree_node(TreeNode* node, std::unordered_map<const void*, std::string>& refs) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_pointer_ref_id(node);
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

inline std::string to_json(TreeNode& node) {
  return to_json(&node);
}

inline std::string to_json(const TreeNode& node) {
  return to_json(&node);
}

template <typename Node>
auto to_json_tree_like_node(Node* node, std::unordered_map<const void*, std::string>& refs) ->
  decltype(node->val, node->left, node->right, std::string()) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_pointer_ref_id(node);
  refs[node] = id;
  return std::string("{\"__type__\":\"TreeNode\",\"__id__\":") + to_json(id) +
    ",\"val\":" + to_json(node->val) +
    ",\"left\":" + to_json_tree_like_node(node->left, refs) +
    ",\"right\":" + to_json_tree_like_node(node->right, refs) + "}";
}

template <typename Node>
auto to_json(Node* node) -> decltype(node->val, node->left, node->right, std::string()) {
  std::unordered_map<const void*, std::string> refs;
  return to_json_tree_like_node(node, refs);
}

template <typename Node>
auto to_json(Node& node) -> decltype(node.val, node.left, node.right, std::string()) {
  return to_json(&node);
}

template <typename Node>
auto to_json(const Node& node) -> decltype(node.val, node.left, node.right, std::string()) {
  return to_json(const_cast<Node*>(&node));
}

template <typename Node>
auto to_json_quad_like_node(Node* node, std::unordered_map<const void*, std::string>& refs) ->
  decltype(node->val, node->isLeaf, node->topLeft, node->topRight, node->bottomLeft, node->bottomRight, std::string()) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_pointer_ref_id(node);
  refs[node] = id;
  return std::string("{\"__type__\":\"Node\",\"__id__\":") + to_json(id) +
    ",\"val\":" + to_json(node->val) +
    ",\"isLeaf\":" + to_json(node->isLeaf) +
    ",\"topLeft\":" + to_json_quad_like_node(node->topLeft, refs) +
    ",\"topRight\":" + to_json_quad_like_node(node->topRight, refs) +
    ",\"bottomLeft\":" + to_json_quad_like_node(node->bottomLeft, refs) +
    ",\"bottomRight\":" + to_json_quad_like_node(node->bottomRight, refs) + "}";
}

template <typename Node>
auto to_json(Node* node) -> decltype(node->val, node->isLeaf, node->topLeft, node->topRight, node->bottomLeft, node->bottomRight, std::string()) {
  std::unordered_map<const void*, std::string> refs;
  return to_json_quad_like_node(node, refs);
}

template <typename Node>
auto to_json_nary_like_node(Node* node, std::unordered_map<const void*, std::string>& refs) ->
  decltype(node->val, node->children, std::string()) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_pointer_ref_id(node);
  refs[node] = id;
  std::string children_json = "[";
  bool first = true;
  for (auto* child : node->children) {
    if (!first) children_json += ",";
    first = false;
    children_json += to_json_nary_like_node(child, refs);
  }
  children_json += "]";
  return std::string("{\"__type__\":\"Node\",\"__id__\":") + to_json(id) +
    ",\"val\":" + to_json(node->val) +
    ",\"children\":" + children_json + "}";
}

template <typename Node>
auto to_json(Node* node) -> decltype(node->val, node->children, std::string()) {
  std::unordered_map<const void*, std::string> refs;
  return to_json_nary_like_node(node, refs);
}

template <typename Node>
std::string to_json_trie_like_node(Node* node, std::unordered_map<const void*, std::string>& refs);

template <typename Node>
std::string to_json_trie_children(const std::unordered_map<char, Node*>& children, std::unordered_map<const void*, std::string>& refs) {
  std::string json = "{";
  bool first = true;
  for (const auto& entry : children) {
    if (entry.second == nullptr) continue;
    if (!first) json += ",";
    first = false;
    json += to_json(std::string(1, entry.first)) + ":" + to_json_trie_like_node(entry.second, refs);
  }
  json += "}";
  return json;
}

template <typename Node, std::size_t Size>
std::string to_json_trie_children(const std::array<Node*, Size>& children, std::unordered_map<const void*, std::string>& refs) {
  std::string json = "{";
  bool first = true;
  for (std::size_t index = 0; index < children.size(); ++index) {
    if (children[index] == nullptr) continue;
    if (!first) json += ",";
    first = false;
    const std::string key = Size == 26 ? std::string(1, static_cast<char>('a' + index)) : std::to_string(index);
    json += to_json(key) + ":" + to_json_trie_like_node(children[index], refs);
  }
  json += "}";
  return json;
}

template <typename Node>
std::string to_json_trie_children(const std::vector<Node*>& children, std::unordered_map<const void*, std::string>& refs) {
  std::string json = "{";
  bool first = true;
  for (std::size_t index = 0; index < children.size(); ++index) {
    if (children[index] == nullptr) continue;
    if (!first) json += ",";
    first = false;
    const std::string key = children.size() == 26 ? std::string(1, static_cast<char>('a' + index)) : std::to_string(index);
    json += to_json(key) + ":" + to_json_trie_like_node(children[index], refs);
  }
  json += "}";
  return json;
}

template <typename Node>
std::string to_json_trie_like_node(Node* node, std::unordered_map<const void*, std::string>& refs) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_pointer_ref_id(node);
  refs[node] = id;
  std::string json = std::string("{\"__type__\":\"TrieNode\",\"__id__\":") + to_json(id) +
    ",\"children\":" + to_json_trie_children(node->children, refs);
  if constexpr (json_has_member_is_end<Node>::value) {
    json += std::string(",\"isEnd\":") + to_json(node->isEnd);
  }
  if constexpr (json_has_member_index<Node>::value) {
    json += std::string(",\"index\":") + to_json(node->index);
  }
  if constexpr (json_has_member_word<Node>::value) {
    json += std::string(",\"word\":") + to_json(node->word);
  }
  json += "}";
  return json;
}

template <typename Node>
auto to_json(Node* node) -> std::enable_if_t<
  !json_has_member_val<Node>::value,
  decltype(node->children, std::string())
> {
  std::unordered_map<const void*, std::string> refs;
  return to_json_trie_like_node(node, refs);
}

inline std::string to_json_list_node(ListNode* node, std::unordered_map<const void*, std::string>& refs) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_pointer_ref_id(node);
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

inline std::string to_json(ListNode& node) {
  return to_json(&node);
}

inline std::string to_json(const ListNode& node) {
  return to_json(&node);
}

template <typename Node>
auto to_json_list_like_node(Node* node, std::unordered_map<const void*, std::string>& refs) ->
  decltype(node->val, node->next, std::string()) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_pointer_ref_id(node);
  refs[node] = id;
  return std::string("{\"__type__\":\"ListNode\",\"__id__\":") + to_json(id) +
    ",\"val\":" + to_json(node->val) +
    ",\"next\":" + to_json_list_like_node(node->next, refs) + "}";
}

template <typename Node>
auto to_json(Node* node) -> decltype(node->val, node->next, std::string()) {
  std::unordered_map<const void*, std::string> refs;
  return to_json_list_like_node(node, refs);
}

template <typename Node>
auto to_json(Node& node) -> decltype(node.val, node.next, std::string()) {
  return to_json(&node);
}

template <typename Node>
auto to_json(const Node& node) -> decltype(node.val, node.next, std::string()) {
  return to_json(const_cast<Node*>(&node));
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

template <typename T>
std::string to_json(const std::vector<T>& values);

template <typename T>
std::string to_json(const std::deque<T>& values);

template <typename T, std::size_t Size>
std::string to_json(const std::array<T, Size>& values);

template <typename T, std::size_t Size>
std::string to_json(const T (&values)[Size]);

template <typename T, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_set<T, Hash, Equal, Allocator>& values);

template <typename K, typename V, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_map<K, V, Hash, Equal, Allocator>& values);

template <typename K, typename V, typename Compare, typename Allocator>
std::string to_json(const std::map<K, V, Compare, Allocator>& values);

template <typename T>
std::enable_if_t<
  !std::is_arithmetic_v<T> &&
  !std::is_pointer_v<T> &&
  !std::is_convertible_v<T, std::string> &&
  !json_has_tree_node_shape<T>::value &&
  !json_has_list_node_shape<T>::value,
  std::string>
to_json(const T&);

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

template <typename... Values>
std::string to_json(const std::variant<Values...>& value) {
  return std::visit([](const auto& item) { return to_json(item); }, value);
}

template <typename T>
std::string to_json(const std::optional<T>& value) {
  return value.has_value() ? to_json(*value) : "null";
}

inline std::string to_json(const std::any& value) {
  if (!value.has_value()) return "null";
  if (value.type() == typeid(int)) return to_json(std::any_cast<int>(value));
  if (value.type() == typeid(long)) return to_json(std::any_cast<long>(value));
  if (value.type() == typeid(long long)) return to_json(std::any_cast<long long>(value));
  if (value.type() == typeid(float)) return to_json(std::any_cast<float>(value));
  if (value.type() == typeid(double)) return to_json(std::any_cast<double>(value));
  if (value.type() == typeid(bool)) return to_json(std::any_cast<bool>(value));
  if (value.type() == typeid(std::string)) return to_json(std::any_cast<std::string>(value));
  if (value.type() == typeid(std::vector<std::any>)) return to_json(std::any_cast<std::vector<std::any>>(value));
  if (value.type() == typeid(std::map<std::string, std::any>)) return to_json(std::any_cast<std::map<std::string, std::any>>(value));
  if (value.type() == typeid(std::unordered_map<std::string, std::any>)) return to_json(std::any_cast<std::unordered_map<std::string, std::any>>(value));
  return "{}";
}

template <typename T, typename Container, typename Compare>
std::string to_json(const std::priority_queue<T, Container, Compare>& values) {
  auto copy = values;
  std::vector<T> out;
  while (!copy.empty()) {
    out.push_back(copy.top());
    copy.pop();
  }
  return to_json(out);
}

template <typename T>
std::enable_if_t<
  !std::is_arithmetic_v<T> &&
  !std::is_pointer_v<T> &&
  !std::is_convertible_v<T, std::string> &&
  !json_has_tree_node_shape<T>::value &&
  !json_has_list_node_shape<T>::value,
  std::string>
to_json(const T&) {
  return "{}";
}

inline std::string mutation_args_json() {
  return "[]";
}

template <typename First, typename... Rest>
std::string mutation_args_json(const First& first, const Rest&... rest) {
  std::string json = "[";
  json += to_json(first);
  ((json += "," + to_json(rest)), ...);
  json += "]";
  return json;
}

template <typename T, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_set<T, Hash, Equal, Allocator>& values);

template <typename K, typename V, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_map<K, V, Hash, Equal, Allocator>& values);

template <typename K, typename V, typename Compare, typename Allocator>
std::string to_json(const std::map<K, V, Compare, Allocator>& values);

template <typename T, std::size_t Size>
std::string to_json(const std::array<T, Size>& values);

template <typename T, std::size_t Size>
std::string to_json(const T (&values)[Size]);

template <typename T>
std::string to_json(const std::deque<T>& values);

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

template <typename T, std::size_t Size>
std::string to_json(const T (&values)[Size]) {
  std::string json = "[";
  for (std::size_t index = 0; index < Size; ++index) {
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

template <typename T, typename Compare, typename Allocator>
std::string to_json(const std::set<T, Compare, Allocator>& values);

template <typename T, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_set<T, Hash, Equal, Allocator>& values);

template <typename K, typename V, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_map<K, V, Hash, Equal, Allocator>& values);

inline void write_trace_event_json(const std::string& event_json, int line = 1);
inline void write_trace_event_json_raw(const std::string& event_json);
inline bool check_trace_budget(int line);
inline void emit_line(int line, const char* function_name);

inline std::string target_json(const std::string& name) {
  return std::string("{\"variable\":") + to_json(name) + "}";
}

template <typename T>
inline void emit_snapshot_value(const std::string& name, const T& value, int line) {
  if (minimal_trace_enabled()) return;
  if (!check_trace_budget(line)) return;
  trace_event_count() += 1;
  write_trace_event_json_raw(
    std::string("{\"kind\":\"snapshot\",\"line\":") + std::to_string(line) +
    ",\"target\":" + target_json(name) +
    ",\"value\":" + to_json(value) + "}"
  );
}

inline std::string target_json(const std::string& name, std::size_t index) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + std::to_string(index) + "]}";
}

inline std::string index_sources_json(const char* source) {
  if (source && *source) {
    return std::string("[") + to_json(std::string(source)) + "]";
  }
  return "[null]";
}

inline std::string index_sources_json(const char* outer_source, const char* inner_source) {
  return std::string("[") +
    ((outer_source && *outer_source) ? to_json(std::string(outer_source)) : "null") +
    "," +
    ((inner_source && *inner_source) ? to_json(std::string(inner_source)) : "null") +
    "]";
}

inline std::string target_json_with_index_source(const std::string& name, std::size_t index, const char* source) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + std::to_string(index) + "],\"indexSources\":" + index_sources_json(source) + "}";
}

inline std::string target_json(const std::string& name, std::size_t outer, std::size_t inner) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + std::to_string(outer) + "," + std::to_string(inner) + "]}";
}

inline std::string target_json_with_index_sources(const std::string& name, std::size_t outer, std::size_t inner, const char* outer_source, const char* inner_source) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + std::to_string(outer) + "," + std::to_string(inner) + "],\"indexSources\":" + index_sources_json(outer_source, inner_source) + "}";
}

template <typename K>
inline std::string target_json_key(const std::string& name, const K& key) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + to_json(key) + "]}";
}

template <typename K>
inline std::string target_json_key_with_index_source(const std::string& name, const K& key, const char* source) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + to_json(key) + "],\"indexSources\":" + index_sources_json(source) + "}";
}

template <typename Container, typename Index>
inline decltype(auto) trace_index_read_value(const Container& container, Index index) {
  if constexpr (requires { container.at(index); }) {
    return container.at(index);
  } else {
    return container[index];
  }
}

template <typename Container, typename Index>
inline auto trace_index_read(const Container& container, const std::string& name, Index index, int line, const char* index_source = nullptr) {
  auto value = trace_index_read_value(container, index);
  if (!minimal_trace_enabled() && check_trace_budget(line)) {
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key_with_index_source(name, index, index_source) +
      ",\"value\":" + to_json(value) + "}"
    );
  }
  return value;
}

template <typename Container, typename Index>
inline auto trace_nested_size_read(const Container& container, const std::string& name, Index index, int line, const char* index_source = nullptr) {
  auto concrete_index = static_cast<std::size_t>(index);
  auto size = trace_index_read_value(container, concrete_index).size();
  if (!minimal_trace_enabled() && check_trace_budget(line)) {
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":{\"variable\":" + to_json(name) +
      ",\"path\":[" + std::to_string(concrete_index) + ",\"size\"],\"indexSources\":" + index_sources_json(index_source, nullptr) + "}" +
      ",\"value\":" + to_json(size) + "}"
    );
  }
  return size;
}

template <typename Container, typename Index>
inline decltype(auto) trace_index_address_read(Container& container, const std::string& name, Index index, int line, const char* index_source = nullptr) {
  auto concrete_index = static_cast<std::size_t>(index);
  if (!minimal_trace_enabled() && check_trace_budget(line)) {
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key_with_index_source(name, concrete_index, index_source) +
      ",\"value\":" + to_json(trace_index_read_value(container, concrete_index)) + "}"
    );
  }
  if constexpr (requires { container.raw(); }) {
    return (container.raw()[concrete_index]);
  } else {
    return (container[concrete_index]);
  }
}

template <typename Container, typename Key>
inline void emit_container_lookup_read_value(const std::string& name, const Container& container, const Key& key, int line, const char* index_source = nullptr) {
  if (minimal_trace_enabled() || !check_trace_budget(line)) return;
  const bool present = container.find(key) != container.end();
  trace_event_count() += 1;
  write_trace_event_json_raw(
    std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
    ",\"target\":" + target_json_key_with_index_source(name, key, index_source) +
    ",\"value\":" + to_json(present) + "}"
  );
}

template <typename Container, typename Key>
inline auto trace_field_container_count(const Container& container, const std::string& object_name, const std::string& field_name, const Key& key, int line, const char* index_source = nullptr) {
  const auto count = container.count(key);
  if (!minimal_trace_enabled() && check_trace_budget(line)) {
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":{\"variable\":" + to_json(object_name) +
      ",\"path\":[" + to_json(field_name) + "," + to_json(key) + "],\"indexSources\":" + index_sources_json(nullptr, index_source) + "}" +
      ",\"value\":" + to_json(count > 0) + "}"
    );
  }
  return count;
}

template <typename Container, typename Index>
inline void emit_index_write_value(const std::string& name, const Container& container, Index index, int line, const char* index_source = nullptr) {
  if (minimal_trace_enabled() || !check_trace_budget(line)) return;
  auto value = trace_index_read_value(container, index);
  trace_event_count() += 1;
  write_trace_event_json_raw(
    std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
    ",\"target\":" + target_json_key_with_index_source(name, index, index_source) +
    ",\"value\":" + to_json(value) + "}"
  );
  emit_snapshot_value(name, container, line);
}

template <typename Container>
inline void emit_container_mutate_value(const std::string& name, const Container& container, const char* method, int line, const std::string& args_json = "") {
  if (!minimal_trace_enabled() && check_trace_budget(line)) {
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(name) +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? std::string(",\"args\":[]") : std::string(",\"args\":") + args_json) +
      "}"
    );
  }
  emit_snapshot_value(name, container, line);
}

template <typename Container>
class StdIndexElementRef {
 public:
  using value_type = typename Container::value_type;

  StdIndexElementRef(Container& owner, std::string name, std::size_t index, const char* source)
      : owner_(owner), name_(std::move(name)), index_(index), source_(source) {}

  operator value_type() const {
    emit_read();
    return static_cast<value_type>(owner_[index_]);
  }

  StdIndexElementRef& operator=(const value_type& value) {
    owner_[index_] = value;
    emit_write();
    return *this;
  }

  StdIndexElementRef& operator=(const StdIndexElementRef& other) {
    value_type value = other;
    return (*this = value);
  }

  StdIndexElementRef& operator+=(const value_type& value) {
    emit_read();
    owner_[index_] += value;
    emit_write();
    return *this;
  }

  StdIndexElementRef& operator-=(const value_type& value) {
    emit_read();
    owner_[index_] -= value;
    emit_write();
    return *this;
  }

  StdIndexElementRef& operator++() {
    emit_read();
    ++owner_[index_];
    emit_write();
    return *this;
  }

  value_type operator++(int) {
    emit_read();
    value_type old = static_cast<value_type>(owner_[index_]);
    owner_[index_] = static_cast<value_type>(old + 1);
    emit_write();
    return old;
  }

  StdIndexElementRef& operator--() {
    emit_read();
    --owner_[index_];
    emit_write();
    return *this;
  }

  value_type operator--(int) {
    emit_read();
    value_type old = static_cast<value_type>(owner_[index_]);
    owner_[index_] = static_cast<value_type>(old - 1);
    emit_write();
    return old;
  }

 private:
  void emit_read() const {
    const int line = trace_event_line();
    if (!minimal_trace_enabled() && check_trace_budget(line)) {
      trace_event_count() += 1;
      write_trace_event_json_raw(
        std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
        ",\"target\":" + target_json_with_index_source(name_, index_, source_) +
        ",\"value\":" + to_json(static_cast<value_type>(owner_[index_])) + "}"
      );
    }
  }

  void emit_write() {
    const int line = trace_event_line();
    if (!minimal_trace_enabled() && check_trace_budget(line)) {
      trace_event_count() += 1;
      write_trace_event_json_raw(
        std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
        ",\"target\":" + target_json_with_index_source(name_, index_, source_) +
        ",\"value\":" + to_json(static_cast<value_type>(owner_[index_])) + "}"
      );
    }
    emit_snapshot_value(name_, owner_, line);
  }

  Container& owner_;
  std::string name_;
  std::size_t index_;
  const char* source_ = nullptr;
};

template <typename Container, typename OuterIndex, typename InnerIndex>
inline auto trace_nested_index_read(const Container& container, const std::string& name, OuterIndex outer, InnerIndex inner, int line, const char* outer_source = nullptr, const char* inner_source = nullptr) {
  const auto& row = trace_index_read_value(container, outer);
  const auto& value = row[inner];
  if (!minimal_trace_enabled() && check_trace_budget(line)) {
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_with_index_sources(name, outer, inner, outer_source, inner_source) +
      ",\"value\":" + to_json(value) + "}"
    );
  }
  return value;
}

template <typename T>
struct is_std_vector : std::false_type {};

template <typename T, typename Allocator>
struct is_std_vector<std::vector<T, Allocator>> : std::true_type {};

template <typename T>
struct is_std_string : std::false_type {};

template <>
struct is_std_string<std::string> : std::true_type {};

template <typename T>
struct is_std_unordered_map : std::false_type {};

template <typename K, typename V, typename Hash, typename Equal, typename Allocator>
struct is_std_unordered_map<std::unordered_map<K, V, Hash, Equal, Allocator>> : std::true_type {};

template <typename T>
struct is_std_map : std::false_type {};

template <typename K, typename V, typename Compare, typename Allocator>
struct is_std_map<std::map<K, V, Compare, Allocator>> : std::true_type {};

template <typename T>
class VectorElementRef;

template <typename T>
class NestedVectorElementRef;

template <typename Map>
class NestedMapElementRef;

inline std::vector<std::string> split_iteration_binding_names(const char* binding_name) {
  std::vector<std::string> names;
  if (!binding_name || !*binding_name) return names;
  std::string current;
  for (const char* cursor = binding_name; *cursor; ++cursor) {
    if (*cursor == ',') {
      std::size_t start = current.find_first_not_of(" \t\r\n");
      std::size_t end = current.find_last_not_of(" \t\r\n");
      if (start != std::string::npos) names.push_back(current.substr(start, end - start + 1));
      current.clear();
      continue;
    }
    current.push_back(*cursor);
  }
  std::size_t start = current.find_first_not_of(" \t\r\n");
  std::size_t end = current.find_last_not_of(" \t\r\n");
  if (start != std::string::npos) names.push_back(current.substr(start, end - start + 1));
  return names;
}

template <typename T, typename = void>
struct is_trace_tuple_like : std::false_type {};

template <typename T>
struct is_trace_tuple_like<T, std::void_t<decltype(std::tuple_size<std::decay_t<T>>::value)>> : std::true_type {};

template <typename Container>
class IndexedRangeReadIterator {
 public:
  using RawIterator = decltype(std::declval<Container&>().raw().begin());
  using difference_type = typename std::iterator_traits<RawIterator>::difference_type;
  using value_type = typename std::iterator_traits<RawIterator>::value_type;
  using reference = typename std::iterator_traits<RawIterator>::reference;
  using pointer = typename std::iterator_traits<RawIterator>::pointer;
  using iterator_category = std::input_iterator_tag;

  IndexedRangeReadIterator(Container& container, RawIterator iterator, std::size_t index, int line, const char* binding_name, bool is_end = false)
      : container_(container), iterator_(iterator), index_(index), line_(line), binding_name_(binding_name), is_end_(is_end) {}

  reference operator*() const {
    if (binding_name_ && *binding_name_) {
      container_.emit_iteration_bind_read(index_, line_, binding_name_);
    } else {
      container_.emit_read(index_, line_);
    }
    return *iterator_;
  }

  pointer operator->() const {
    if (binding_name_ && *binding_name_) {
      container_.emit_iteration_bind_read(index_, line_, binding_name_);
    } else {
      container_.emit_read(index_, line_);
    }
    return &(*iterator_);
  }

  IndexedRangeReadIterator& operator++() {
    ++iterator_;
    ++index_;
    return *this;
  }

  IndexedRangeReadIterator operator++(int) {
    IndexedRangeReadIterator copy = *this;
    ++(*this);
    return copy;
  }

  bool operator==(const IndexedRangeReadIterator& other) const {
    const bool equal = iterator_ == other.iterator_;
    if (equal && (is_end_ || other.is_end_)) emit_line(line_, "");
    return equal;
  }

  bool operator!=(const IndexedRangeReadIterator& other) const {
    return !(*this == other);
  }

 private:
  Container& container_;
  RawIterator iterator_;
  std::size_t index_;
  int line_;
  const char* binding_name_;
  bool is_end_;
};

template <typename Container>
class IndexedRangeReadable {
 public:
  explicit IndexedRangeReadable(Container& container, int line, const char* binding_name = nullptr)
      : container_(container), line_(line), binding_name_(binding_name) {}

  auto begin() {
    return IndexedRangeReadIterator<Container>(container_, container_.raw().begin(), 0, line_, binding_name_, false);
  }

  auto end() {
    return IndexedRangeReadIterator<Container>(container_, container_.raw().end(), container_.raw().size(), line_, binding_name_, true);
  }

 private:
  Container& container_;
  int line_;
  const char* binding_name_;
};

template <typename T>
class IndexedNestedRangeReadIterator {
 public:
  using Row = std::vector<T>;
  using RawIterator = typename Row::iterator;
  using difference_type = typename std::iterator_traits<RawIterator>::difference_type;
  using value_type = typename std::iterator_traits<RawIterator>::value_type;
  using reference = typename std::iterator_traits<RawIterator>::reference;
  using pointer = typename std::iterator_traits<RawIterator>::pointer;
  using iterator_category = std::input_iterator_tag;

  IndexedNestedRangeReadIterator(Row& row, RawIterator iterator, const std::string& name, std::size_t outer, std::size_t inner, int line, const char* outer_source, const char* binding_name, bool is_end = false)
      : row_(row), iterator_(iterator), name_(name), outer_(outer), inner_(inner), line_(line), outer_source_(outer_source), binding_name_(binding_name), is_end_(is_end) {}

  reference operator*() const {
    emit_iteration_bind_read();
    return *iterator_;
  }

  pointer operator->() const {
    emit_iteration_bind_read();
    return &(*iterator_);
  }

  IndexedNestedRangeReadIterator& operator++() {
    ++iterator_;
    ++inner_;
    return *this;
  }

  IndexedNestedRangeReadIterator operator++(int) {
    IndexedNestedRangeReadIterator copy = *this;
    ++(*this);
    return copy;
  }

  bool operator==(const IndexedNestedRangeReadIterator& other) const {
    const bool equal = iterator_ == other.iterator_;
    if (equal && (is_end_ || other.is_end_)) emit_line(line_, "");
    return equal;
  }

  bool operator!=(const IndexedNestedRangeReadIterator& other) const {
    return !(*this == other);
  }

 private:
  void emit_iteration_bind_read() const {
    if (minimal_trace_enabled() || !check_trace_budget(line_)) return;
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line_) +
      ",\"target\":" + target_json_with_index_sources(name_, outer_, inner_, outer_source_, nullptr) +
      ",\"value\":" + to_json(*iterator_) +
      ((binding_name_ && *binding_name_)
        ? std::string(",\"binding\":{\"kind\":\"iteration\",\"variable\":") + to_json(binding_name_) + "}"
        : std::string("")) +
      "}"
    );
  }

  Row& row_;
  RawIterator iterator_;
  std::string name_;
  std::size_t outer_;
  mutable std::size_t inner_;
  int line_;
  const char* outer_source_;
  const char* binding_name_;
  bool is_end_;
};

template <typename T>
class IndexedNestedRangeReadable {
 public:
  IndexedNestedRangeReadable(std::vector<T>& row, const std::string& name, std::size_t outer, int line, const char* outer_source = nullptr, const char* binding_name = nullptr)
      : row_(row), name_(name), outer_(outer), line_(line), outer_source_(outer_source), binding_name_(binding_name) {}

  auto begin() {
    return IndexedNestedRangeReadIterator<T>(row_, row_.begin(), name_, outer_, 0, line_, outer_source_, binding_name_, false);
  }

  auto end() {
    return IndexedNestedRangeReadIterator<T>(row_, row_.end(), name_, outer_, row_.size(), line_, outer_source_, binding_name_, true);
  }

 private:
  std::vector<T>& row_;
  std::string name_;
  std::size_t outer_;
  int line_;
  const char* outer_source_;
  const char* binding_name_;
};

template <typename Container>
class KeyedRangeReadIterator {
 public:
  using RawIterator = decltype(std::declval<Container&>().raw().begin());
  using difference_type = typename std::iterator_traits<RawIterator>::difference_type;
  using value_type = typename std::iterator_traits<RawIterator>::value_type;
  using reference = typename std::iterator_traits<RawIterator>::reference;
  using pointer = typename std::iterator_traits<RawIterator>::pointer;
  using iterator_category = std::input_iterator_tag;

  KeyedRangeReadIterator(Container& container, RawIterator iterator, int line, const char* key_binding_name, const char* value_binding_name, bool is_end = false)
      : container_(container), iterator_(iterator), line_(line), key_binding_name_(key_binding_name), value_binding_name_(value_binding_name), is_end_(is_end) {}

  reference operator*() const {
    emit_iteration_bind_read();
    return *iterator_;
  }

  pointer operator->() const {
    emit_iteration_bind_read();
    return &(*iterator_);
  }

  KeyedRangeReadIterator& operator++() {
    ++iterator_;
    return *this;
  }

  KeyedRangeReadIterator operator++(int) {
    KeyedRangeReadIterator copy = *this;
    ++(*this);
    return copy;
  }

  bool operator==(const KeyedRangeReadIterator& other) const {
    const bool equal = iterator_ == other.iterator_;
    if (equal && (is_end_ || other.is_end_)) emit_line(line_, "");
    return equal;
  }

  bool operator!=(const KeyedRangeReadIterator& other) const {
    return !(*this == other);
  }

 private:
  void emit_iteration_bind_read() const {
    if (key_binding_name_ && *key_binding_name_) {
      container_.emit_iteration_bind_read(iterator_->first, to_json(iterator_->second), line_, key_binding_name_);
    } else {
      container_.emit_read(iterator_->first, line_, to_json(iterator_->second));
    }
    if (value_binding_name_ && *value_binding_name_) {
      container_.emit_iteration_bind_read(iterator_->first, to_json(iterator_->second), line_, value_binding_name_);
    }
  }

  Container& container_;
  RawIterator iterator_;
  int line_;
  const char* key_binding_name_;
  const char* value_binding_name_;
  bool is_end_;
};

template <typename Container>
class KeyedRangeReadable {
 public:
  KeyedRangeReadable(Container& container, int line, const char* key_binding_name = nullptr, const char* value_binding_name = nullptr)
      : container_(container), line_(line), key_binding_name_(key_binding_name), value_binding_name_(value_binding_name) {}

  auto begin() {
    return KeyedRangeReadIterator<Container>(container_, container_.raw().begin(), line_, key_binding_name_, value_binding_name_, false);
  }

  auto end() {
    return KeyedRangeReadIterator<Container>(container_, container_.raw().end(), line_, key_binding_name_, value_binding_name_, true);
  }

 private:
  Container& container_;
  int line_;
  const char* key_binding_name_;
  const char* value_binding_name_;
};

class IndexedStringRangeReadIterator {
 public:
  using RawIterator = std::string::iterator;
  using difference_type = typename std::iterator_traits<RawIterator>::difference_type;
  using value_type = typename std::iterator_traits<RawIterator>::value_type;
  using reference = typename std::iterator_traits<RawIterator>::reference;
  using pointer = typename std::iterator_traits<RawIterator>::pointer;
  using iterator_category = std::input_iterator_tag;

  IndexedStringRangeReadIterator(std::string& value, RawIterator iterator, std::size_t index, int line, const char* binding_name, const char* source_name, bool is_end = false)
      : value_(value), iterator_(iterator), index_(index), line_(line), binding_name_(binding_name), source_name_(source_name), is_end_(is_end) {}

  reference operator*() const {
    emit_read();
    return *iterator_;
  }

  pointer operator->() const {
    emit_read();
    return &(*iterator_);
  }

  IndexedStringRangeReadIterator& operator++() {
    ++iterator_;
    ++index_;
    return *this;
  }

  IndexedStringRangeReadIterator operator++(int) {
    IndexedStringRangeReadIterator copy = *this;
    ++(*this);
    return copy;
  }

  bool operator==(const IndexedStringRangeReadIterator& other) const {
    const bool equal = iterator_ == other.iterator_;
    if (equal && (is_end_ || other.is_end_)) emit_line(line_, "");
    return equal;
  }

  bool operator!=(const IndexedStringRangeReadIterator& other) const {
    return !(*this == other);
  }

 private:
  std::string& value_;
  RawIterator iterator_;
  std::size_t index_;
  int line_;
  const char* binding_name_;
  const char* source_name_;
  bool is_end_;

  void emit_read() const {
    const char item = *iterator_;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line_) +
      ",\"target\":" + target_json_with_index_source(source_name_ ? source_name_ : "", index_, nullptr) +
      ",\"value\":" + to_json(std::string(1, item)) +
      ((binding_name_ && *binding_name_)
        ? std::string(",\"binding\":{\"kind\":\"iteration\",\"variable\":") + to_json(binding_name_) + "}"
        : std::string("")) +
      "}",
      line_
    );
  }
};

class IndexedStringRangeReadable {
 public:
  explicit IndexedStringRangeReadable(std::string& value, int line, const char* binding_name = nullptr, const char* source_name = nullptr)
      : value_(value), line_(line), binding_name_(binding_name), source_name_(source_name) {}

  auto begin() {
    return IndexedStringRangeReadIterator(value_, value_.begin(), 0, line_, binding_name_, source_name_, false);
  }

  auto end() {
    return IndexedStringRangeReadIterator(value_, value_.end(), value_.size(), line_, binding_name_, source_name_, true);
  }

 private:
  std::string& value_;
  int line_;
  const char* binding_name_;
  const char* source_name_;
};

class IndexedConstStringRangeReadIterator {
 public:
  using RawIterator = std::string::const_iterator;
  using difference_type = typename std::iterator_traits<RawIterator>::difference_type;
  using value_type = char;
  using reference = char;
  using pointer = const char*;
  using iterator_category = std::input_iterator_tag;

  IndexedConstStringRangeReadIterator(const std::string& value, RawIterator iterator, std::size_t index, int line, const char* binding_name, const char* source_name, bool is_end = false)
      : value_(value), iterator_(iterator), index_(index), line_(line), binding_name_(binding_name), source_name_(source_name), is_end_(is_end) {}

  char operator*() const {
    emit_read();
    return *iterator_;
  }

  IndexedConstStringRangeReadIterator& operator++() {
    ++iterator_;
    ++index_;
    return *this;
  }

  IndexedConstStringRangeReadIterator operator++(int) {
    IndexedConstStringRangeReadIterator copy = *this;
    ++(*this);
    return copy;
  }

  bool operator==(const IndexedConstStringRangeReadIterator& other) const {
    const bool equal = iterator_ == other.iterator_;
    if (equal && (is_end_ || other.is_end_)) emit_line(line_, "");
    return equal;
  }

  bool operator!=(const IndexedConstStringRangeReadIterator& other) const {
    return !(*this == other);
  }

 private:
  const std::string& value_;
  RawIterator iterator_;
  std::size_t index_;
  int line_;
  const char* binding_name_;
  const char* source_name_;
  bool is_end_;

  void emit_read() const {
    const char item = *iterator_;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line_) +
      ",\"target\":" + target_json_with_index_source(source_name_ ? source_name_ : "", index_, nullptr) +
      ",\"value\":" + to_json(std::string(1, item)) +
      ((binding_name_ && *binding_name_)
        ? std::string(",\"binding\":{\"kind\":\"iteration\",\"variable\":") + to_json(binding_name_) + "}"
        : std::string("")) +
      "}",
      line_
    );
  }
};

class IndexedConstStringRangeReadable {
 public:
  explicit IndexedConstStringRangeReadable(const std::string& value, int line, const char* binding_name = nullptr, const char* source_name = nullptr)
      : value_(value), line_(line), binding_name_(binding_name), source_name_(source_name) {}

  auto begin() const {
    return IndexedConstStringRangeReadIterator(value_, value_.begin(), 0, line_, binding_name_, source_name_, false);
  }

  auto end() const {
    return IndexedConstStringRangeReadIterator(value_, value_.end(), value_.size(), line_, binding_name_, source_name_, true);
  }

 private:
  const std::string& value_;
  int line_;
  const char* binding_name_;
  const char* source_name_;
};

template <typename T>
class Vector : public std::vector<T> {
 public:
  using Base = std::vector<T>;
  using value_type = T;
  using iterator = typename Base::iterator;
  using const_iterator = typename Base::const_iterator;

  using Base::assign;
  using Base::insert;

  Vector() : Base(), values_(static_cast<Base&>(*this)), name_("vector"), path_prefix_json_(""), trace_(false) {}

  Vector(const char* name, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Vector(const char* name, const char* field, int line)
      : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Vector(std::initializer_list<T> values) : Base(values), values_(static_cast<Base&>(*this)), name_("vector"), path_prefix_json_(""), trace_(false) {}

  Vector(const std::vector<T>& values) : Base(values), values_(static_cast<Base&>(*this)), name_("vector"), path_prefix_json_(""), trace_(false) {}

  Vector(std::vector<T>&& values) : Base(std::move(values)), values_(static_cast<Base&>(*this)), name_("vector"), path_prefix_json_(""), trace_(false) {}

  Vector(const Vector<T>& other)
      : Base(static_cast<const Base&>(other)),
        values_(static_cast<Base&>(*this)),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  Vector(Vector<T>&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(static_cast<Base&>(*this)),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  Vector(std::initializer_list<T> values, const char* name, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Vector(std::initializer_list<T> values, const char* name, const char* field, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Vector(const std::vector<T>& values, const char* name, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Vector(const std::vector<T>& values, const char* name, const char* field, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Vector& operator=(const std::vector<T>& values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Vector& operator=(const Vector<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Vector& operator=(Vector<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Vector& operator=(std::initializer_list<T> values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const {
    const auto result = values_.size();
    emit_metadata_read("size", result, trace_event_line());
    return result;
  }
  bool empty() const { return values_.empty(); }
  std::size_t capacity() const { return values_.capacity(); }

  void reserve(std::size_t count) {
    values_.reserve(count);
  }

  template <typename... Args>
  T& emplace_back(Args&&... args) {
    emit_receiver_read(trace_event_line());
    auto args_json = mutation_args_json(args...);
    std::size_t index = values_.size();
    T& result = values_.emplace_back(std::forward<Args>(args)...);
    emit_mutate("emplace_back", trace_event_line(), args_json);
    emit_write(index, values_[index], trace_event_line());
    return result;
  }

  VectorElementRef<T> operator[](std::size_t index) {
    return VectorElementRef<T>(*this, index);
  }

  VectorElementRef<T> with_index_source(std::size_t index, const char* source) {
    return VectorElementRef<T>(*this, index, source);
  }

  const T& with_index_source(std::size_t index, const char* source) const {
    emit_read(index, trace_event_line(), source);
    return values_[index];
  }

  const T& operator[](std::size_t index) const {
    emit_read(index, trace_event_line());
    return values_[index];
  }

  T& at(std::size_t index) {
    emit_read(index, trace_event_line());
    return values_.at(index);
  }

  const T& at(std::size_t index) const {
    emit_read(index, trace_event_line());
    return values_.at(index);
  }

  VectorElementRef<T> front() {
    return VectorElementRef<T>(*this, 0);
  }

  const T& front() const {
    emit_read(0, trace_event_line());
    return values_.front();
  }

  VectorElementRef<T> back() {
    return VectorElementRef<T>(*this, values_.size() - 1);
  }

  const T& back() const {
    emit_read(values_.size() - 1, trace_event_line());
    return values_.back();
  }

  void push_back(const T& value) {
    emit_receiver_read(trace_event_line());
    std::size_t index = values_.size();
    values_.push_back(value);
    emit_mutate("push_back", trace_event_line(), mutation_args_json(value));
    emit_write(index, values_[index], trace_event_line());
  }

  void push_back(T&& value) {
    emit_receiver_read(trace_event_line());
    auto args_json = mutation_args_json(value);
    std::size_t index = values_.size();
    values_.push_back(std::move(value));
    emit_mutate("push_back", trace_event_line(), args_json);
    emit_write(index, values_[index], trace_event_line());
  }

  void pop_back() {
    emit_receiver_read(trace_event_line());
    values_.pop_back();
    emit_mutate("pop_back", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void resize(std::size_t count) {
    emit_receiver_read(trace_event_line());
    values_.resize(count);
    emit_mutate("resize", trace_event_line(), mutation_args_json(count));
    emit_snapshot(trace_event_line());
  }

  void resize(std::size_t count, const T& value) {
    emit_receiver_read(trace_event_line());
    values_.resize(count, value);
    emit_mutate("resize", trace_event_line(), mutation_args_json(count, value));
    emit_snapshot(trace_event_line());
  }

  void clear() {
    emit_receiver_read(trace_event_line());
    values_.clear();
    emit_mutate("clear", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void swap(Vector<T>& other) {
    emit_receiver_read(trace_event_line());
    other.emit_receiver_read(trace_event_line());
    values_.swap(other.values_);
    emit_mutate("swap", trace_event_line());
    other.emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
    other.emit_snapshot(trace_event_line());
  }

  void swap(std::vector<T>& other) {
    emit_receiver_read(trace_event_line());
    values_.swap(other);
    emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void assign(std::size_t count, const T& value) {
    emit_receiver_read(trace_event_line());
    values_.assign(count, value);
    emit_mutate("assign", trace_event_line(), mutation_args_json(count, value));
    emit_snapshot(trace_event_line());
  }

  void assign(std::initializer_list<T> values) {
    emit_receiver_read(trace_event_line());
    values_.assign(values);
    emit_mutate("assign", trace_event_line(), mutation_args_json(std::vector<T>(values)));
    emit_snapshot(trace_event_line());
  }

  iterator insert(const_iterator position, const T& value) {
    emit_receiver_read(trace_event_line());
    auto result = values_.insert(position, value);
    emit_mutate("insert", trace_event_line(), mutation_args_json(value));
    emit_snapshot(trace_event_line());
    return result;
  }

  iterator insert(const_iterator position, T&& value) {
    emit_receiver_read(trace_event_line());
    auto args_json = mutation_args_json(value);
    auto result = values_.insert(position, std::move(value));
    emit_mutate("insert", trace_event_line(), args_json);
    emit_snapshot(trace_event_line());
    return result;
  }

  iterator insert(const_iterator position, std::size_t count, const T& value) {
    emit_receiver_read(trace_event_line());
    auto result = values_.insert(position, count, value);
    emit_mutate("insert", trace_event_line(), mutation_args_json(count, value));
    emit_snapshot(trace_event_line());
    return result;
  }

  template <typename InputIt>
  iterator insert(const_iterator position, InputIt first, InputIt last) {
    emit_receiver_read(trace_event_line());
    auto result = values_.insert(position, first, last);
    emit_mutate("insert", trace_event_line());
    emit_snapshot(trace_event_line());
    return result;
  }

  iterator erase(const_iterator position) {
    emit_receiver_read(trace_event_line());
    auto position_index = std::distance(values_.cbegin(), position);
    auto result = values_.erase(position);
    emit_mutate("erase", trace_event_line(), mutation_args_json(position_index));
    emit_snapshot(trace_event_line());
    return result;
  }

  iterator erase(const_iterator first, const_iterator last) {
    emit_receiver_read(trace_event_line());
    auto first_index = std::distance(values_.cbegin(), first);
    auto last_index = std::distance(values_.cbegin(), last);
    auto result = values_.erase(first, last);
    emit_mutate("erase", trace_event_line(), mutation_args_json(first_index, last_index));
    emit_snapshot(trace_event_line());
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

  void emit_read(std::size_t index, int line, const char* source = nullptr) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + (source && *source ? target_json_with_index_source(index, source) : target_json(index)) +
      ",\"value\":" + to_json(values_[index]) + "}",
      line
    );
  }

  void emit_iteration_bind_read(std::size_t index, int line, const char* binding_name) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_with_index_source(index, nullptr) +
      ",\"value\":" + to_json(values_[index]) +
      ",\"binding\":{\"kind\":\"iteration\",\"variable\":" + to_json(binding_name) + "}}",
      line
    );
    emit_destructured_iteration_bind_reads(index, line, binding_name);
  }

  void emit_iteration_component_bind_read(std::size_t index, std::size_t component, int line, const std::string& binding_name, const std::string& value_json) const {
    if (!trace_ || binding_name.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(index, component) +
      ",\"value\":" + value_json +
      ",\"binding\":{\"kind\":\"iteration\",\"variable\":" + to_json(binding_name) + "}}",
      line
    );
  }

  template <typename Value, std::size_t... Indices>
  void emit_tuple_component_bind_reads(std::size_t index, int line, const std::vector<std::string>& binding_names, const Value& value, std::index_sequence<Indices...>) const {
    ((Indices < binding_names.size()
      ? emit_iteration_component_bind_read(index, Indices, line, binding_names[Indices], to_json(std::get<Indices>(value)))
      : void()), ...);
  }

  void emit_destructured_iteration_bind_reads(std::size_t index, int line, const char* binding_name) const {
    std::vector<std::string> binding_names = split_iteration_binding_names(binding_name);
    if (binding_names.size() <= 1) return;
    const T& value = values_[index];
    if constexpr (is_trace_tuple_like<T>::value) {
      constexpr std::size_t tuple_size = std::tuple_size_v<std::decay_t<T>>;
      emit_tuple_component_bind_reads(index, line, binding_names, value, std::make_index_sequence<tuple_size>{});
    }
  }

  void emit_receiver_read(int line) const {
    if (!trace_ || path_prefix_json_.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
      line
    );
  }

  template <typename Value>
  void emit_metadata_read(const char* field, const Value& value, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(field) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  emit_nested_read(std::size_t outer, std::size_t inner, int line, const char* outer_source = nullptr, const char* inner_source = nullptr) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + ((outer_source && *outer_source) || (inner_source && *inner_source)
        ? target_json_with_index_sources(name_, outer, inner, outer_source, inner_source)
        : target_json(outer, inner)) +
      ",\"value\":" + to_json(values_[outer][inner]) + "}",
      line
    );
  }

  template <typename U = T>
  std::enable_if_t<is_std_string<U>::value, void>
  emit_string_char_read(std::size_t outer, std::size_t inner, int line) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(outer, inner) +
      ",\"value\":" + to_json(values_[outer][inner]) + "}",
      line
    );
  }

  void emit_write(std::size_t index, const T& value, int line, const char* source = nullptr) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + (source && *source ? target_json_with_index_source(index, source) : target_json(index)) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  emit_nested_write(std::size_t outer, std::size_t inner, const typename U::value_type& value, int line, const char* outer_source = nullptr, const char* inner_source = nullptr) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + ((outer_source && *outer_source) || (inner_source && *inner_source)
        ? target_json_with_index_sources(name_, outer, inner, outer_source, inner_source)
        : target_json(outer, inner)) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  template <typename Key>
  void emit_nested_key_read(std::size_t outer, const Key& key, int line) const {
    if (!trace_) return;
    const auto found = values_[outer].find(key);
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(outer, key) +
      ",\"value\":" + (found == values_[outer].end() ? "null" : to_json(found->second)) + "}",
      line
    );
  }

  template <typename Key, typename Value>
  void emit_nested_key_write(std::size_t outer, const Key& key, const Value& value, int line) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json(outer, key) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  void emit_indexed_mutate(std::size_t index, const char* method, int line, const char* source = nullptr, const std::string& args_json = "") {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + (source && *source ? target_json_with_index_source(index, source) : target_json(index)) +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? std::string("") : std::string(",\"args\":") + args_json) +
      "}",
      line
    );
  }

  void emit_mutate(const char* method, int line) {
    emit_mutate(method, line, "");
  }

  void emit_mutate(const char* method, int line, const std::string& args_json) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
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

  const std::string& trace_name() const { return name_; }
  void set_trace_name(const char* name) { name_ = name; }

 private:
  Base& values_;
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

  std::string target_json(const char* field) const {
    if (path_prefix_json_.empty()) return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + to_json(field) + "]}";
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(field) + "]}";
  }

  std::string target_json_with_index_source(std::size_t index, const char* source) const {
    if (path_prefix_json_.empty()) return tracecode::target_json_with_index_source(name_, index, source);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + std::to_string(index) + "],\"indexSources\":" + tracecode::index_sources_json(nullptr, source) + "}";
  }

  std::string target_json(std::size_t outer, std::size_t inner) const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_, outer, inner);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + std::to_string(outer) + "," + std::to_string(inner) + "]}";
  }

  template <typename Key>
  std::string target_json(std::size_t outer, const Key& key) const {
    if (path_prefix_json_.empty()) {
      return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + std::to_string(outer) + "," + to_json(key) + "]}";
    }
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + std::to_string(outer) + "," + to_json(key) + "]}";
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
  friend class NestedMapElementRef;
  template <typename U>
  friend class IndexedRangeReadIterator;
};

template <typename T>
inline IndexedRangeReadable<Vector<T>> indexed_range_readable(Vector<T>& container, int line, const char* binding_name = nullptr, const char* = nullptr) {
  return IndexedRangeReadable<Vector<T>>(container, line, binding_name);
}

template <typename T, typename OuterIndex>
inline IndexedNestedRangeReadable<T> indexed_nested_range_readable(Vector<std::vector<T>>& container, const std::string& name, OuterIndex outer, const char* outer_source, int line, const char* binding_name = nullptr) {
  auto concrete_outer = static_cast<std::size_t>(outer);
  auto& raw_container = static_cast<std::vector<std::vector<T>>&>(container);
  if (!minimal_trace_enabled() && check_trace_budget(line)) {
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_with_index_source(name, concrete_outer, outer_source) +
      ",\"value\":" + to_json(raw_container[concrete_outer]) + "}"
    );
  }
  return IndexedNestedRangeReadable<T>(raw_container[concrete_outer], name, concrete_outer, line, outer_source, binding_name);
}

template <typename VectorType>
class StdVectorIndexedRangeReadIterator {
 public:
  using RawIterator = decltype(std::declval<VectorType&>().begin());
  using difference_type = typename std::iterator_traits<RawIterator>::difference_type;
  using value_type = typename std::iterator_traits<RawIterator>::value_type;
  using reference = typename std::iterator_traits<RawIterator>::reference;
  using pointer = typename std::iterator_traits<RawIterator>::pointer;
  using iterator_category = std::input_iterator_tag;

  StdVectorIndexedRangeReadIterator(VectorType& container, RawIterator iterator, std::size_t index, int line, const char* binding_name, const char* source_name, bool is_end = false)
      : container_(container), iterator_(iterator), index_(index), line_(line), binding_name_(binding_name), source_name_(source_name), is_end_(is_end) {}

  reference operator*() const {
    emit_read();
    return *iterator_;
  }

  pointer operator->() const {
    emit_read();
    return &(*iterator_);
  }

  StdVectorIndexedRangeReadIterator& operator++() {
    ++iterator_;
    ++index_;
    return *this;
  }

  StdVectorIndexedRangeReadIterator operator++(int) {
    StdVectorIndexedRangeReadIterator copy = *this;
    ++(*this);
    return copy;
  }

  bool operator==(const StdVectorIndexedRangeReadIterator& other) const {
    const bool equal = iterator_ == other.iterator_;
    if (equal && (is_end_ || other.is_end_)) emit_line(line_, "");
    return equal;
  }

  bool operator!=(const StdVectorIndexedRangeReadIterator& other) const {
    return !(*this == other);
  }

 private:
  void emit_read() const {
    if (minimal_trace_enabled() || !source_name_ || !*source_name_ || !check_trace_budget(line_)) return;
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line_) +
      ",\"target\":" + target_json_with_index_source(source_name_, index_, nullptr) +
      ",\"value\":" + to_json(*iterator_) +
      ((binding_name_ && *binding_name_)
        ? std::string(",\"binding\":{\"kind\":\"iteration\",\"variable\":") + to_json(binding_name_) + "}"
        : std::string("")) +
      "}"
    );
    emit_destructured_iteration_bind_reads();
  }

  void emit_iteration_component_bind_read(std::size_t component, const std::string& binding_name, const std::string& value_json) const {
    if (!binding_name.empty() && check_trace_budget(line_)) {
      trace_event_count() += 1;
      write_trace_event_json_raw(
        std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line_) +
        ",\"target\":" + tracecode::target_json(std::string(source_name_), index_, component) +
        ",\"value\":" + value_json +
        ",\"binding\":{\"kind\":\"iteration\",\"variable\":" + to_json(binding_name) + "}}"
      );
    }
  }

  template <typename Value, std::size_t... Indices>
  void emit_tuple_component_bind_reads(const std::vector<std::string>& binding_names, const Value& value, std::index_sequence<Indices...>) const {
    ((Indices < binding_names.size()
      ? emit_iteration_component_bind_read(Indices, binding_names[Indices], to_json(std::get<Indices>(value)))
      : void()), ...);
  }

  void emit_destructured_iteration_bind_reads() const {
    std::vector<std::string> binding_names = split_iteration_binding_names(binding_name_);
    if (binding_names.size() <= 1) return;
    using Item = std::decay_t<decltype(*iterator_)>;
    if constexpr (is_trace_tuple_like<Item>::value) {
      constexpr std::size_t tuple_size = std::tuple_size_v<Item>;
      emit_tuple_component_bind_reads(binding_names, *iterator_, std::make_index_sequence<tuple_size>{});
    }
  }

  VectorType& container_;
  RawIterator iterator_;
  std::size_t index_;
  int line_;
  const char* binding_name_;
  const char* source_name_;
  bool is_end_;
};

template <typename VectorType>
class StdVectorIndexedRangeReadable {
 public:
  StdVectorIndexedRangeReadable(VectorType& container, int line, const char* binding_name = nullptr, const char* source_name = nullptr)
      : container_(container), line_(line), binding_name_(binding_name), source_name_(source_name) {}

  auto begin() {
    return StdVectorIndexedRangeReadIterator<VectorType>(container_, container_.begin(), 0, line_, binding_name_, source_name_, false);
  }

  auto end() {
    return StdVectorIndexedRangeReadIterator<VectorType>(container_, container_.end(), container_.size(), line_, binding_name_, source_name_, true);
  }

 private:
  VectorType& container_;
  int line_;
  const char* binding_name_;
  const char* source_name_;
};

template <typename T, typename Allocator>
inline StdVectorIndexedRangeReadable<std::vector<T, Allocator>> indexed_range_readable(std::vector<T, Allocator>& container, int line, const char* binding_name = nullptr, const char* source_name = nullptr) {
  return StdVectorIndexedRangeReadable<std::vector<T, Allocator>>(container, line, binding_name, source_name);
}

template <typename T, typename Allocator>
inline StdVectorIndexedRangeReadable<const std::vector<T, Allocator>> indexed_range_readable(const std::vector<T, Allocator>& container, int line, const char* binding_name = nullptr, const char* source_name = nullptr) {
  return StdVectorIndexedRangeReadable<const std::vector<T, Allocator>>(container, line, binding_name, source_name);
}

inline IndexedStringRangeReadable indexed_range_readable(std::string& value, int line, const char* binding_name = nullptr, const char* source_name = nullptr) {
  return IndexedStringRangeReadable(value, line, binding_name, source_name);
}

inline IndexedConstStringRangeReadable indexed_range_readable(const std::string& value, int line, const char* binding_name = nullptr, const char* source_name = nullptr) {
  return IndexedConstStringRangeReadable(value, line, binding_name, source_name);
}

template <typename T, typename Index>
inline decltype(auto) trace_index_read_value(const Vector<T>& container, Index index) {
  return container.raw()[index];
}

template <typename T>
class VectorElementRef {
 public:
  VectorElementRef(Vector<T>& owner, std::size_t index) : owner_(owner), index_(index) {}
  VectorElementRef(Vector<T>& owner, std::size_t index, const char* source) : owner_(owner), index_(index), source_(source) {}

  T& get() {
    owner_.emit_read(index_, trace_event_line(), source_);
    return owner_.values_[index_];
  }

  const T& get() const {
    owner_.emit_read(index_, trace_event_line(), source_);
    return owner_.values_[index_];
  }

  operator T() const {
    owner_.emit_read(index_, trace_event_line(), source_);
    return owner_.values_[index_];
  }

  VectorElementRef& operator=(const T& value) {
    owner_.values_[index_] = value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator=(const VectorElementRef& other) {
    T value = other;
    return (*this = value);
  }

  VectorElementRef& operator+=(const T& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_] += value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator-=(const T& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_] -= value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator*=(const T& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_] *= value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator/=(const T& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_] /= value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator%=(const T& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_] %= value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator^=(const T& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_] ^= value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator|=(const T& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_] |= value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator&=(const T& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_] &= value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  VectorElementRef& operator++() {
    owner_.emit_read(index_, trace_event_line(), source_);
    ++owner_.values_[index_];
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  T operator++(int) {
    owner_.emit_read(index_, trace_event_line(), source_);
    T old = owner_.values_[index_]++;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return old;
  }

  VectorElementRef& operator--() {
    owner_.emit_read(index_, trace_event_line(), source_);
    --owner_.values_[index_];
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return *this;
  }

  T operator--(int) {
    owner_.emit_read(index_, trace_event_line(), source_);
    T old = owner_.values_[index_]--;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line(), source_);
    return old;
  }

  T* operator->() {
    return &get();
  }

  const T* operator->() const {
    return &get();
  }

  template <typename U = T>
  auto size() const -> decltype(std::declval<const U&>().size()) {
    return get().size();
  }

  template <typename U = T>
  auto empty() const -> decltype(std::declval<const U&>().empty()) {
    return get().empty();
  }

  template <typename U = T>
  auto length() const -> decltype(std::declval<const U&>().length()) {
    return get().length();
  }

  template <typename... Args, typename U = T>
  auto substr(Args&&... args) const -> decltype(std::declval<const U&>().substr(std::forward<Args>(args)...)) {
    return get().substr(std::forward<Args>(args)...);
  }

  template <typename Value, typename U = T>
  auto insert(Value&& value) -> decltype(std::declval<U&>().insert(std::forward<Value>(value))) {
    auto args_json = std::string("[") + to_json(value) + "]";
    auto result = owner_.values_[index_].insert(std::forward<Value>(value));
    owner_.emit_indexed_mutate(index_, "insert", trace_event_line(), source_, args_json);
    owner_.emit_snapshot(trace_event_line());
    return result;
  }

  template <typename... Args, typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  assign(Args&&... args) {
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_].assign(std::forward<Args>(args)...);
    owner_.emit_indexed_mutate(index_, "assign", trace_event_line(), source_);
    owner_.emit_snapshot(trace_event_line());
  }

  template <typename Value, typename U = T>
  auto contains(const Value& value) const -> decltype(std::declval<const U&>().contains(value)) {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].contains(value);
  }

  template <typename Value, typename U = T>
  auto count(const Value& value) const -> decltype(std::declval<const U&>().count(value)) {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].count(value);
  }

  template <typename Value, typename U = T>
  auto find(const Value& value) -> decltype(std::declval<U&>().find(value)) {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].find(value);
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, NestedVectorElementRef<typename U::value_type>>
  operator[](std::size_t innerIndex) {
    return NestedVectorElementRef<typename U::value_type>(
      reinterpret_cast<Vector<std::vector<typename U::value_type>>&>(owner_),
      index_,
      innerIndex,
      source_,
      nullptr
    );
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_reference>
  operator[](std::size_t innerIndex) const {
    owner_.emit_nested_read(index_, innerIndex, trace_event_line());
    return owner_.values_[index_][innerIndex];
  }

  template <typename U = T>
  std::enable_if_t<is_std_string<U>::value, char>
  operator[](std::size_t innerIndex) {
    owner_.emit_string_char_read(index_, innerIndex, trace_event_line());
    return owner_.values_[index_][innerIndex];
  }

  template <typename Key, typename U = T>
  std::enable_if_t<is_std_unordered_map<U>::value, NestedMapElementRef<U>>
  operator[](const Key& key) {
    return NestedMapElementRef<U>(owner_, index_, key);
  }

  template <typename Key, typename U = T>
  std::enable_if_t<is_std_map<U>::value, NestedMapElementRef<U>>
  operator[](const Key& key) {
    return NestedMapElementRef<U>(owner_, index_, key);
  }

  template <typename Key, typename U = T>
  std::enable_if_t<!is_std_vector<U>::value && !is_std_string<U>::value && !is_std_unordered_map<U>::value && !is_std_map<U>::value, decltype(std::declval<U&>()[std::declval<Key>()])>
  operator[](const Key& key) {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_][key];
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  push_back(const typename U::value_type& value) {
    owner_.emit_read(index_, trace_event_line(), source_);
    std::size_t inner_index = owner_.values_[index_].size();
    owner_.values_[index_].push_back(value);
    owner_.emit_indexed_mutate(index_, "push_back", trace_event_line(), source_, std::string("[") + to_json(value) + "]");
    owner_.emit_nested_write(index_, inner_index, owner_.values_[index_][inner_index], trace_event_line(), source_, nullptr);
  }

  template <typename Value, typename U = T>
  auto push_back(Value&& value) -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<U&>().push_back(std::forward<Value>(value)), void())> {
    auto args_json = std::string("[") + to_json(value) + "]";
    owner_.emit_read(index_, trace_event_line(), source_);
    owner_.values_[index_].push_back(std::forward<Value>(value));
    owner_.emit_indexed_mutate(index_, "push_back", trace_event_line(), source_, args_json);
    owner_.emit_snapshot(trace_event_line());
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  pop_back() {
    owner_.values_[index_].pop_back();
    owner_.emit_indexed_mutate(index_, "pop_back", trace_event_line(), source_);
    owner_.emit_snapshot(trace_event_line());
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::reference>
  front() {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].front();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_reference>
  front() const {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].front();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::reference>
  back() {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].back();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_reference>
  back() const {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].back();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::iterator>
  begin() {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].begin();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::iterator>
  end() {
    return owner_.values_[index_].end();
  }

  template <typename U = T>
  auto begin() -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<U&>().begin())> {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].begin();
  }

  template <typename U = T>
  auto end() -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<U&>().end())> {
    return owner_.values_[index_].end();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_iterator>
  begin() const {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].begin();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_iterator>
  end() const {
    return owner_.values_[index_].end();
  }

  template <typename U = T>
  auto begin() const -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<const U&>().begin())> {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].begin();
  }

  template <typename U = T>
  auto end() const -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<const U&>().end())> {
    return owner_.values_[index_].end();
  }

  template <typename U = T>
  auto has_value() const -> decltype(std::declval<const U&>().has_value()) {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].has_value();
  }

  template <typename U = T>
  auto value() -> decltype(std::declval<U&>().value()) {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].value();
  }

  template <typename U = T>
  auto value() const -> decltype(std::declval<const U&>().value()) {
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_].value();
  }

 private:
  Vector<T>& owner_;
  std::size_t index_;
  const char* source_ = nullptr;
};

inline std::istream& getline(std::istream& input, VectorElementRef<std::string> target, char delimiter) {
  std::string value;
  std::istream& result = std::getline(input, value, delimiter);
  target = value;
  return result;
}

inline std::istream& getline(std::istream& input, VectorElementRef<std::string> target) {
  std::string value;
  std::istream& result = std::getline(input, value);
  target = value;
  return result;
}

template <typename T>
class NestedVectorElementRef {
 public:
  NestedVectorElementRef(Vector<std::vector<T>>& owner, std::size_t outer, std::size_t inner)
      : owner_(owner), outer_(outer), inner_(inner) {}
  NestedVectorElementRef(Vector<std::vector<T>>& owner, std::size_t outer, std::size_t inner, const char* outer_source, const char* inner_source)
      : owner_(owner), outer_(outer), inner_(inner), outer_source_(outer_source), inner_source_(inner_source) {}

  operator T() const {
    emit_read();
    return owner_.values_[outer_][inner_];
  }

  NestedVectorElementRef& operator=(const T& value) {
    owner_.values_[outer_][inner_] = value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator=(const NestedVectorElementRef& other) {
    T value = other;
    return (*this = value);
  }

  NestedVectorElementRef& operator+=(const T& value) {
    emit_read();
    owner_.values_[outer_][inner_] += value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator-=(const T& value) {
    emit_read();
    owner_.values_[outer_][inner_] -= value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator*=(const T& value) {
    emit_read();
    owner_.values_[outer_][inner_] *= value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator/=(const T& value) {
    emit_read();
    owner_.values_[outer_][inner_] /= value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator%=(const T& value) {
    emit_read();
    owner_.values_[outer_][inner_] %= value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator^=(const T& value) {
    emit_read();
    owner_.values_[outer_][inner_] ^= value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator|=(const T& value) {
    emit_read();
    owner_.values_[outer_][inner_] |= value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator&=(const T& value) {
    emit_read();
    owner_.values_[outer_][inner_] &= value;
    emit_write();
    return *this;
  }

  NestedVectorElementRef& operator++() {
    emit_read();
    ++owner_.values_[outer_][inner_];
    emit_write();
    return *this;
  }

  T operator++(int) {
    emit_read();
    T old = owner_.values_[outer_][inner_]++;
    emit_write();
    return old;
  }

  NestedVectorElementRef& operator--() {
    emit_read();
    --owner_.values_[outer_][inner_];
    emit_write();
    return *this;
  }

  T operator--(int) {
    emit_read();
    T old = owner_.values_[outer_][inner_]--;
    emit_write();
    return old;
  }

  template <typename Index, typename U = T>
  auto operator[](Index index) -> decltype(std::declval<U&>()[index]) {
    emit_read();
    return owner_.values_[outer_][inner_][index];
  }

  template <typename Value, typename U = T>
  auto insert(Value&& value) -> decltype(std::declval<U&>().insert(std::forward<Value>(value))) {
    auto result = owner_.values_[outer_][inner_].insert(std::forward<Value>(value));
    owner_.emit_indexed_mutate(outer_, "insert", trace_event_line());
    owner_.emit_snapshot(trace_event_line());
    return result;
  }

  template <typename InputIt, typename U = T>
  auto insert(InputIt first, InputIt last) -> decltype(std::declval<U&>().insert(first, last), void()) {
    owner_.values_[outer_][inner_].insert(first, last);
    owner_.emit_indexed_mutate(outer_, "insert", trace_event_line());
    owner_.emit_snapshot(trace_event_line());
  }

  template <typename Value, typename U = T>
  auto contains(const Value& value) const -> decltype(std::declval<const U&>().contains(value)) {
    emit_read();
    return owner_.values_[outer_][inner_].contains(value);
  }

  template <typename Value, typename U = T>
  auto count(const Value& value) const -> decltype(std::declval<const U&>().count(value)) {
    emit_read();
    return owner_.values_[outer_][inner_].count(value);
  }

  template <typename Value, typename U = T>
  auto find(const Value& value) -> decltype(std::declval<U&>().find(value)) {
    emit_read();
    return owner_.values_[outer_][inner_].find(value);
  }

  template <typename Value, typename U = T>
  auto find(const Value& value) const -> decltype(std::declval<const U&>().find(value)) {
    emit_read();
    return owner_.values_[outer_][inner_].find(value);
  }

  template <typename U = T>
  auto begin() -> decltype(std::declval<U&>().begin()) {
    emit_read();
    return owner_.values_[outer_][inner_].begin();
  }

  template <typename U = T>
  auto end() -> decltype(std::declval<U&>().end()) {
    return owner_.values_[outer_][inner_].end();
  }

  template <typename U = T>
  auto begin() const -> decltype(std::declval<const U&>().begin()) {
    emit_read();
    return owner_.values_[outer_][inner_].begin();
  }

  template <typename U = T>
  auto end() const -> decltype(std::declval<const U&>().end()) {
    return owner_.values_[outer_][inner_].end();
  }

 private:
  void emit_read() const {
    owner_.emit_nested_read(outer_, inner_, trace_event_line(), outer_source_, inner_source_);
  }

  void emit_write() {
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], trace_event_line(), outer_source_, inner_source_);
  }

  Vector<std::vector<T>>& owner_;
  std::size_t outer_;
  std::size_t inner_;
  const char* outer_source_ = nullptr;
  const char* inner_source_ = nullptr;
};

template <typename T>
class StdNestedVectorElementRef {
 public:
  StdNestedVectorElementRef(std::vector<std::vector<T>>& owner, std::string name, std::size_t outer, std::size_t inner, const char* outer_source, const char* inner_source)
      : owner_(owner), name_(std::move(name)), outer_(outer), inner_(inner), outer_source_(outer_source), inner_source_(inner_source) {}

  operator T() const {
    emit_read();
    return owner_[outer_][inner_];
  }

  StdNestedVectorElementRef& operator=(const T& value) {
    owner_[outer_][inner_] = value;
    emit_write();
    return *this;
  }

  StdNestedVectorElementRef& operator=(const StdNestedVectorElementRef& other) {
    T value = other;
    return (*this = value);
  }

  StdNestedVectorElementRef& operator+=(const T& value) {
    emit_read();
    owner_[outer_][inner_] += value;
    emit_write();
    return *this;
  }

  StdNestedVectorElementRef& operator-=(const T& value) {
    emit_read();
    owner_[outer_][inner_] -= value;
    emit_write();
    return *this;
  }

  StdNestedVectorElementRef& operator*=(const T& value) {
    emit_read();
    owner_[outer_][inner_] *= value;
    emit_write();
    return *this;
  }

  StdNestedVectorElementRef& operator/=(const T& value) {
    emit_read();
    owner_[outer_][inner_] /= value;
    emit_write();
    return *this;
  }

  StdNestedVectorElementRef& operator%=(const T& value) {
    emit_read();
    owner_[outer_][inner_] %= value;
    emit_write();
    return *this;
  }

  StdNestedVectorElementRef& operator++() {
    emit_read();
    ++owner_[outer_][inner_];
    emit_write();
    return *this;
  }

  T operator++(int) {
    emit_read();
    T old = owner_[outer_][inner_]++;
    emit_write();
    return old;
  }

  StdNestedVectorElementRef& operator--() {
    emit_read();
    --owner_[outer_][inner_];
    emit_write();
    return *this;
  }

  T operator--(int) {
    emit_read();
    T old = owner_[outer_][inner_]--;
    emit_write();
    return old;
  }

 private:
  void emit_read() const {
    const int line = trace_event_line();
    if (!minimal_trace_enabled() && check_trace_budget(line)) {
      trace_event_count() += 1;
      write_trace_event_json_raw(
        std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
        ",\"target\":" + target_json_with_index_sources(name_, outer_, inner_, outer_source_, inner_source_) +
        ",\"value\":" + to_json(owner_[outer_][inner_]) + "}"
      );
    }
  }

  void emit_write() {
    const int line = trace_event_line();
    if (!minimal_trace_enabled() && check_trace_budget(line)) {
      trace_event_count() += 1;
      write_trace_event_json_raw(
        std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
        ",\"target\":" + target_json_with_index_sources(name_, outer_, inner_, outer_source_, inner_source_) +
        ",\"value\":" + to_json(owner_[outer_][inner_]) + "}"
      );
    }
    emit_snapshot_value(name_, owner_, line);
  }

  std::vector<std::vector<T>>& owner_;
  std::string name_;
  std::size_t outer_;
  std::size_t inner_;
  const char* outer_source_ = nullptr;
  const char* inner_source_ = nullptr;
};

template <typename T, typename OuterIndex, typename InnerIndex>
inline NestedVectorElementRef<T> trace_nested_index_ref(Vector<std::vector<T>>& container, OuterIndex outer, InnerIndex inner, const char* outer_source = nullptr, const char* inner_source = nullptr) {
  return NestedVectorElementRef<T>(
    container,
    static_cast<std::size_t>(outer),
    static_cast<std::size_t>(inner),
    outer_source,
    inner_source
  );
}

template <typename T, typename OuterIndex, typename InnerIndex>
inline NestedVectorElementRef<T> trace_nested_index_ref(Vector<std::vector<T>>& container, const std::string&, OuterIndex outer, InnerIndex inner, const char* outer_source = nullptr, const char* inner_source = nullptr) {
  return trace_nested_index_ref(container, outer, inner, outer_source, inner_source);
}

template <typename T, typename OuterIndex, typename InnerIndex>
inline StdNestedVectorElementRef<T> trace_nested_index_ref(std::vector<std::vector<T>>& container, const std::string& name, OuterIndex outer, InnerIndex inner, const char* outer_source = nullptr, const char* inner_source = nullptr) {
  return StdNestedVectorElementRef<T>(
    container,
    name,
    static_cast<std::size_t>(outer),
    static_cast<std::size_t>(inner),
    outer_source,
    inner_source
  );
}

template <typename Map, typename OuterIndex, typename Key>
inline std::enable_if_t<is_std_unordered_map<Map>::value || is_std_map<Map>::value, NestedMapElementRef<Map>>
trace_nested_index_ref(Vector<Map>& container, const std::string&, OuterIndex outer, const Key& key, const char* = nullptr, const char* = nullptr) {
  return NestedMapElementRef<Map>(container, static_cast<std::size_t>(outer), key);
}

template <typename T, typename Index>
inline VectorElementRef<T> trace_index_ref(Vector<T>& container, const std::string&, Index index, const char* source = nullptr) {
  return container.with_index_source(static_cast<std::size_t>(index), source);
}

template <typename T, typename Index>
inline StdIndexElementRef<std::vector<T>> trace_index_ref(std::vector<T>& container, const std::string& name, Index index, const char* source = nullptr) {
  return StdIndexElementRef<std::vector<T>>(container, name, static_cast<std::size_t>(index), source);
}

class StdNestedStringElementRef {
 public:
  StdNestedStringElementRef(std::vector<std::string>& owner, std::string name, std::size_t outer, std::size_t inner, const char* outer_source, const char* inner_source)
      : owner_(owner), name_(std::move(name)), outer_(outer), inner_(inner), outer_source_(outer_source), inner_source_(inner_source) {}

  operator char() const {
    emit_read();
    return owner_[outer_][inner_];
  }

  StdNestedStringElementRef& operator=(char value) {
    owner_[outer_][inner_] = value;
    emit_write();
    return *this;
  }

 private:
  void emit_read() const {
    const int line = trace_event_line();
    if (!minimal_trace_enabled() && check_trace_budget(line)) {
      trace_event_count() += 1;
      write_trace_event_json_raw(
        std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
        ",\"target\":" + target_json_with_index_sources(name_, outer_, inner_, outer_source_, inner_source_) +
        ",\"value\":" + to_json(std::string(1, owner_[outer_][inner_])) + "}"
      );
    }
  }

  void emit_write() {
    const int line = trace_event_line();
    if (!minimal_trace_enabled() && check_trace_budget(line)) {
      trace_event_count() += 1;
      write_trace_event_json_raw(
        std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
        ",\"target\":" + target_json_with_index_sources(name_, outer_, inner_, outer_source_, inner_source_) +
        ",\"value\":" + to_json(std::string(1, owner_[outer_][inner_])) + "}"
      );
    }
    emit_snapshot_value(name_, owner_, line);
  }

  std::vector<std::string>& owner_;
  std::string name_;
  std::size_t outer_;
  std::size_t inner_;
  const char* outer_source_ = nullptr;
  const char* inner_source_ = nullptr;
};

template <typename OuterIndex, typename InnerIndex>
inline StdNestedStringElementRef trace_nested_index_ref(std::vector<std::string>& container, const std::string& name, OuterIndex outer, InnerIndex inner, const char* outer_source = nullptr, const char* inner_source = nullptr) {
  return StdNestedStringElementRef(
    container,
    name,
    static_cast<std::size_t>(outer),
    static_cast<std::size_t>(inner),
    outer_source,
    inner_source
  );
}

template <typename Map>
class NestedMapElementRef {
 public:
  using key_type = typename Map::key_type;
  using mapped_type = typename Map::mapped_type;

  NestedMapElementRef(Vector<Map>& owner, std::size_t outer, const key_type& key)
      : owner_(owner), outer_(outer), key_(key) {}

  operator mapped_type() const {
    owner_.emit_nested_key_read(outer_, key_, trace_event_line());
    return owner_.values_[outer_][key_];
  }

  NestedMapElementRef& operator=(const mapped_type& value) {
    owner_.values_[outer_][key_] = value;
    owner_.emit_nested_key_write(outer_, key_, owner_.values_[outer_][key_], trace_event_line());
    return *this;
  }

  NestedMapElementRef& operator+=(const mapped_type& value) {
    owner_.emit_nested_key_read(outer_, key_, trace_event_line());
    owner_.values_[outer_][key_] += value;
    owner_.emit_nested_key_write(outer_, key_, owner_.values_[outer_][key_], trace_event_line());
    return *this;
  }

 private:
  Vector<Map>& owner_;
  std::size_t outer_;
  key_type key_;
};

template <typename T>
std::string to_json(const Vector<T>& values) {
  return to_json(values.raw());
}

template <typename T>
bool operator==(const Vector<T>& left, const Vector<T>& right) {
  return left.raw() == right.raw();
}

template <typename T>
bool operator!=(const Vector<T>& left, const Vector<T>& right) {
  return !(left == right);
}

template <typename T, typename U>
bool operator==(const VectorElementRef<T>& left, const U& right) {
  T materialized = left;
  return materialized == right;
}

template <typename T, typename U>
bool operator==(const NestedVectorElementRef<T>& left, const U& right) {
  T materialized = left;
  return materialized == right;
}

template <typename T>
bool operator==(const NestedVectorElementRef<T>& left, const NestedVectorElementRef<T>& right) {
  T leftValue = left;
  T rightValue = right;
  return leftValue == rightValue;
}

inline bool operator==(const NestedVectorElementRef<std::string>& left, const char* right) {
  std::string materialized = left;
  return materialized == right;
}

inline bool operator==(const char* left, const NestedVectorElementRef<std::string>& right) {
  std::string materialized = right;
  return left == materialized;
}

template <typename T>
bool operator==(const VectorElementRef<T>& left, const VectorElementRef<T>& right) {
  T leftValue = left;
  T rightValue = right;
  return leftValue == rightValue;
}

template <typename T, typename U>
bool operator==(const U& left, const VectorElementRef<T>& right) {
  T materialized = right;
  return left == materialized;
}

template <typename T, typename U>
bool operator!=(const VectorElementRef<T>& left, const U& right) {
  return !(left == right);
}

template <typename T, typename U>
bool operator!=(const NestedVectorElementRef<T>& left, const U& right) {
  return !(left == right);
}

template <typename T>
bool operator!=(const NestedVectorElementRef<T>& left, const NestedVectorElementRef<T>& right) {
  return !(left == right);
}

template <typename T, typename U>
bool operator!=(const U& left, const VectorElementRef<T>& right) {
  return !(left == right);
}

template <typename T, typename U>
bool operator!=(const U& left, const NestedVectorElementRef<T>& right) {
  return !(left == right);
}

template <typename T, typename U>
bool operator<(const VectorElementRef<T>& left, const U& right) {
  T materialized = left;
  return materialized < right;
}

template <typename T>
bool operator<(const VectorElementRef<T>& left, const VectorElementRef<T>& right) {
  T leftValue = left;
  T rightValue = right;
  return leftValue < rightValue;
}

template <typename T, typename U>
bool operator<(const U& left, const VectorElementRef<T>& right) {
  T materialized = right;
  return left < materialized;
}

template <typename T, typename U>
bool operator>(const VectorElementRef<T>& left, const U& right) {
  return right < left;
}

template <typename T>
bool operator>(const VectorElementRef<T>& left, const VectorElementRef<T>& right) {
  T leftValue = left;
  T rightValue = right;
  return leftValue > rightValue;
}

template <typename T, typename U>
bool operator>(const U& left, const VectorElementRef<T>& right) {
  return right < left;
}

template <typename T, typename U>
bool operator<=(const VectorElementRef<T>& left, const U& right) {
  return !(right < left);
}

template <typename T>
bool operator<=(const VectorElementRef<T>& left, const VectorElementRef<T>& right) {
  return !(right < left);
}

template <typename T, typename U>
bool operator<=(const U& left, const VectorElementRef<T>& right) {
  return !(right < left);
}

template <typename T, typename U>
bool operator>=(const VectorElementRef<T>& left, const U& right) {
  return !(left < right);
}

template <typename T>
bool operator>=(const VectorElementRef<T>& left, const VectorElementRef<T>& right) {
  return !(left < right);
}

template <typename T, typename U>
bool operator>=(const U& left, const VectorElementRef<T>& right) {
  return !(left < right);
}

template <typename T>
class DequeElementRef;

template <typename T>
class Deque : public std::deque<T> {
 public:
  using Base = std::deque<T>;
  using value_type = T;
  using iterator = typename Base::iterator;
  using const_iterator = typename Base::const_iterator;

  Deque() : Base(), values_(static_cast<Base&>(*this)), name_("deque"), path_prefix_json_(""), trace_(false) {}
  Deque(const char* name, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Deque(const char* name, const char* field, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Deque(std::initializer_list<T> values) : Base(values), values_(static_cast<Base&>(*this)), name_("deque"), path_prefix_json_(""), trace_(false) {}
  Deque(const std::deque<T>& values) : Base(values), values_(static_cast<Base&>(*this)), name_("deque"), path_prefix_json_(""), trace_(false) {}
  Deque(std::deque<T>&& values) : Base(std::move(values)), values_(static_cast<Base&>(*this)), name_("deque"), path_prefix_json_(""), trace_(false) {}

  Deque(const Deque<T>& other)
      : Base(static_cast<const Base&>(other)),
        values_(static_cast<Base&>(*this)),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  Deque(Deque<T>&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(static_cast<Base&>(*this)),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  Deque(std::initializer_list<T> values, const char* name, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Deque(std::initializer_list<T> values, const char* name, const char* field, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Deque(const std::deque<T>& values, const char* name, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Deque(const std::deque<T>& values, const char* name, const char* field, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  Deque& operator=(const std::deque<T>& values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Deque& operator=(const Deque<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Deque& operator=(Deque<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Deque& operator=(std::initializer_list<T> values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  DequeElementRef<T> operator[](std::size_t index) { return DequeElementRef<T>(*this, index); }

  const T& operator[](std::size_t index) const {
    emit_read(index, trace_event_line());
    return values_[index];
  }

  DequeElementRef<T> front() { return DequeElementRef<T>(*this, 0); }

  const T& front() const {
    emit_read(0, trace_event_line());
    return values_.front();
  }

  DequeElementRef<T> back() { return DequeElementRef<T>(*this, values_.size() - 1); }

  const T& back() const {
    emit_read(values_.size() - 1, trace_event_line());
    return values_.back();
  }

  void push_back(const T& value) {
    std::size_t index = values_.size();
    values_.push_back(value);
    emit_mutate("push_back", trace_event_line(), mutation_args_json(value));
    emit_write(index, values_[index], trace_event_line());
  }

  void push_back(T&& value) {
    auto args_json = mutation_args_json(value);
    std::size_t index = values_.size();
    values_.push_back(std::move(value));
    emit_mutate("push_back", trace_event_line(), args_json);
    emit_write(index, values_[index], trace_event_line());
  }

  void push_front(const T& value) {
    values_.push_front(value);
    emit_mutate("push_front", trace_event_line(), mutation_args_json(value));
    emit_write(0, values_[0], trace_event_line());
  }

  void push_front(T&& value) {
    auto args_json = mutation_args_json(value);
    values_.push_front(std::move(value));
    emit_mutate("push_front", trace_event_line(), args_json);
    emit_write(0, values_[0], trace_event_line());
  }

  void pop_back() {
    values_.pop_back();
    emit_mutate("pop_back", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void pop_front() {
    values_.pop_front();
    emit_mutate("pop_front", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", trace_event_line());
    emit_snapshot(trace_event_line());
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
    emit_mutate(method, line, "");
  }

  void emit_mutate(const char* method, int line, const std::string& args_json) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
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
  Base& values_;
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
    owner_.emit_read(index_, trace_event_line());
    return owner_.values_[index_];
  }

  DequeElementRef& operator=(const T& value) {
    owner_.values_[index_] = value;
    owner_.emit_write(index_, owner_.values_[index_], trace_event_line());
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
class Queue : public std::queue<T> {
 public:
  using Base = std::queue<T>;
  using Container = typename Base::container_type;

  using Base::swap;

  Queue() : Base(), values_(this->c), name_("queue"), path_prefix_json_(""), trace_(false) {}
  Queue(const char* name, int line) : Base(), values_(this->c), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Queue(const char* name, const char* field, int line) : Base(), values_(this->c), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Queue(const std::deque<T>& values, const char* name, int line) : Base(values), values_(this->c), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Queue(const std::deque<T>& values, const char* name, const char* field, int line) : Base(values), values_(this->c), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  Queue(const Queue<T>& other)
      : Base(static_cast<const Base&>(other)),
        values_(this->c),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  Queue(Queue<T>&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(this->c),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  Queue& operator=(const Queue<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_snapshot(trace_event_line());
    return *this;
  }

  Queue& operator=(Queue<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  T& front() {
    emit_read("front", values_.front(), trace_event_line());
    return values_.front();
  }

  const T& front() const {
    emit_read("front", values_.front(), trace_event_line());
    return values_.front();
  }

  T& back() {
    emit_read("back", values_.back(), trace_event_line());
    return values_.back();
  }

  const T& back() const {
    emit_read("back", values_.back(), trace_event_line());
    return values_.back();
  }

  void push(const T& value) {
    std::size_t index = values_.size();
    values_.push_back(value);
    emit_mutate("push", trace_event_line(), mutation_args_json(value));
    emit_write(index, values_[index], trace_event_line());
  }

  void push(T&& value) {
    auto args_json = mutation_args_json(value);
    std::size_t index = values_.size();
    values_.push_back(std::move(value));
    emit_mutate("push", trace_event_line(), args_json);
    emit_write(index, values_[index], trace_event_line());
  }

  template <typename... Args>
  T& emplace(Args&&... args) {
    auto args_json = mutation_args_json(args...);
    std::size_t index = values_.size();
    T& result = values_.emplace_back(std::forward<Args>(args)...);
    emit_mutate("emplace", trace_event_line(), args_json);
    emit_write(index, values_[index], trace_event_line());
    return result;
  }

  void pop() {
    values_.pop_front();
    emit_mutate("pop", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void swap(Queue<T>& other) {
    Base::swap(other);
    emit_mutate("swap", trace_event_line());
    other.emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
    other.emit_snapshot(trace_event_line());
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
    emit_mutate(method, line, "");
  }

  void emit_mutate(const char* method, int line, const std::string& args_json) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
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
  Container& values_;
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

template <typename T, typename Container = std::vector<T>, typename Compare = std::less<T>>
class PriorityQueue : public std::priority_queue<T, Container, Compare> {
 public:
  using Base = std::priority_queue<T, Container, Compare>;

  using Base::swap;

  PriorityQueue() : Base(), values_(static_cast<Base&>(*this)), name_("priority_queue"), path_prefix_json_(""), trace_(false) {}
  PriorityQueue(const char* name, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  PriorityQueue(const char* name, const char* field, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  PriorityQueue(const Compare& compare, const char* name, int line) : Base(compare), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  PriorityQueue(const Compare& compare, const char* name, const char* field, int line) : Base(compare), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  PriorityQueue(const std::vector<T>& values, const char* name, int line) : Base(values.begin(), values.end()), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }
  PriorityQueue(const std::vector<T>& values, const char* name, const char* field, int line) : Base(values.begin(), values.end()), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  PriorityQueue(const PriorityQueue<T, Container, Compare>& other)
      : Base(static_cast<const Base&>(other)),
        values_(static_cast<Base&>(*this)),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  PriorityQueue(PriorityQueue<T, Container, Compare>&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(static_cast<Base&>(*this)),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  PriorityQueue& operator=(const PriorityQueue<T, Container, Compare>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_snapshot(trace_event_line());
    return *this;
  }

  PriorityQueue& operator=(PriorityQueue<T, Container, Compare>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  const T& top() const {
    emit_read("top", values_.top(), trace_event_line());
    return values_.top();
  }

  void push(const T& value) {
    values_.push(value);
    emit_mutate("push", trace_event_line(), mutation_args_json(value));
    emit_snapshot(trace_event_line());
  }

  void push(T&& value) {
    auto args_json = mutation_args_json(value);
    values_.push(std::move(value));
    emit_mutate("push", trace_event_line(), args_json);
    emit_snapshot(trace_event_line());
  }

  template <typename... Args>
  void emplace(Args&&... args) {
    auto args_json = mutation_args_json(args...);
    values_.emplace(std::forward<Args>(args)...);
    emit_mutate("emplace", trace_event_line(), args_json);
    emit_snapshot(trace_event_line());
  }

  void pop() {
    values_.pop();
    emit_mutate("pop", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void swap(PriorityQueue<T, Container, Compare>& other) {
    Base::swap(other);
    emit_mutate("swap", trace_event_line());
    other.emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
    other.emit_snapshot(trace_event_line());
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
    emit_mutate(method, line, "");
  }

  void emit_mutate(const char* method, int line, const std::string& args_json) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
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
  Base& values_;
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

template <typename T, typename Container, typename Compare>
std::string to_json(const PriorityQueue<T, Container, Compare>& values) {
  return to_json(values.snapshot_values());
}

template <typename T>
class Stack : public std::stack<T> {
 public:
  using Base = std::stack<T>;
  using Container = typename Base::container_type;

  using Base::swap;

  Stack() : Base(), values_(this->c), name_("stack"), path_prefix_json_(""), trace_(false) {}
  Stack(const char* name, int line) : Base(), values_(this->c), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Stack(const char* name, const char* field, int line) : Base(), values_(this->c), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Stack(const std::deque<T>& values, const char* name, int line) : Base(values), values_(this->c), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Stack(const std::deque<T>& values, const char* name, const char* field, int line) : Base(values), values_(this->c), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  Stack(const Stack<T>& other)
      : Base(static_cast<const Base&>(other)),
        values_(this->c),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  Stack(Stack<T>&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(this->c),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  Stack& operator=(const Stack<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_snapshot(trace_event_line());
    return *this;
  }

  Stack& operator=(Stack<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  T& top() {
    emit_read("top", values_.back(), trace_event_line());
    return values_.back();
  }

  const T& top() const {
    emit_read("top", values_.back(), trace_event_line());
    return values_.back();
  }

  void push(const T& value) {
    std::size_t index = values_.size();
    values_.push_back(value);
    emit_mutate("push", trace_event_line(), mutation_args_json(value));
    emit_write(index, values_[index], trace_event_line());
  }

  void push(T&& value) {
    auto args_json = mutation_args_json(value);
    std::size_t index = values_.size();
    values_.push_back(std::move(value));
    emit_mutate("push", trace_event_line(), args_json);
    emit_write(index, values_[index], trace_event_line());
  }

  template <typename... Args>
  T& emplace(Args&&... args) {
    auto args_json = mutation_args_json(args...);
    std::size_t index = values_.size();
    T& result = values_.emplace_back(std::forward<Args>(args)...);
    emit_mutate("emplace", trace_event_line(), args_json);
    emit_write(index, values_[index], trace_event_line());
    return result;
  }

  void pop() {
    values_.pop_back();
    emit_mutate("pop", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void swap(Stack<T>& other) {
    Base::swap(other);
    emit_mutate("swap", trace_event_line());
    other.emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
    other.emit_snapshot(trace_event_line());
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
    emit_mutate(method, line, "");
  }

  void emit_mutate(const char* method, int line, const std::string& args_json) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
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
  Container& values_;
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

template <typename K, typename V, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_map<K, V, Hash, Equal, Allocator>& values) {
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
class UnorderedMap : public std::unordered_map<K, V> {
 public:
  using Base = std::unordered_map<K, V>;
  using key_type = K;
  using mapped_type = V;
  using iterator = typename Base::iterator;
  using const_iterator = typename Base::const_iterator;

  using Base::erase;
  using Base::insert;
  using Base::swap;

  UnorderedMap() : Base(), values_(static_cast<Base&>(*this)), name_("map"), path_prefix_json_(""), trace_(false) {}

  UnorderedMap(const char* name, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(const char* name, const char* field, int line)
      : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(std::initializer_list<std::pair<const K, V>> values)
      : Base(values), values_(static_cast<Base&>(*this)), name_("map"), path_prefix_json_(""), trace_(false) {}

  UnorderedMap(const std::unordered_map<K, V>& values)
      : Base(values), values_(static_cast<Base&>(*this)), name_("map"), path_prefix_json_(""), trace_(false) {}

  UnorderedMap(std::unordered_map<K, V>&& values)
      : Base(std::move(values)), values_(static_cast<Base&>(*this)), name_("map"), path_prefix_json_(""), trace_(false) {}

  UnorderedMap(const UnorderedMap<K, V>& other)
      : Base(static_cast<const Base&>(other)),
        values_(static_cast<Base&>(*this)),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  UnorderedMap(UnorderedMap<K, V>&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(static_cast<Base&>(*this)),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  UnorderedMap(std::initializer_list<std::pair<const K, V>> values, const char* name, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(std::initializer_list<std::pair<const K, V>> values, const char* name, const char* field, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(const std::unordered_map<K, V>& values, const char* name, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap(const std::unordered_map<K, V>& values, const char* name, const char* field, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  UnorderedMap& operator=(const std::unordered_map<K, V>& values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  UnorderedMap& operator=(const UnorderedMap<K, V>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  UnorderedMap& operator=(UnorderedMap<K, V>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  UnorderedMap& operator=(std::initializer_list<std::pair<const K, V>> values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }
  void reserve(std::size_t count) {
    values_.reserve(count);
  }

  void max_load_factor(float value) {
    values_.max_load_factor(value);
    emit_mutate("max_load_factor", trace_event_line());
  }

  float max_load_factor() const {
    return values_.max_load_factor();
  }

  std::size_t count(const K& key) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.count(key);
  }

  std::size_t count_with_index_source(const K& key, const char* source) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null", source);
    return values_.count(key);
  }

  bool contains(const K& key) const {
    return count(key) > 0;
  }

  iterator find(const K& key) {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.find(key);
  }

  const_iterator find(const K& key) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.find(key);
  }

  iterator find_with_index_source(const K& key, const char* source) {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null", source);
    return values_.find(key);
  }

  const_iterator find_with_index_source(const K& key, const char* source) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null", source);
    return values_.find(key);
  }

  UnorderedMapValueRef<K, V> operator[](const K& key) {
    return UnorderedMapValueRef<K, V>(*this, key);
  }

  UnorderedMapValueRef<K, V> with_index_source(const K& key, const char* source) {
    return UnorderedMapValueRef<K, V>(*this, key, source);
  }

  UnorderedMapValueRef<K, V> with_index_source(const K& key, const char* source, int line) {
    current_trace_line() = line;
    return UnorderedMapValueRef<K, V>(*this, key, source);
  }

  V at(const K& key) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.at(key);
  }

  std::pair<iterator, bool> insert(const typename Base::value_type& value) {
    auto result = values_.insert(value);
    if (result.second) {
      emit_write(value.first, result.first->second, trace_event_line());
    }
    return result;
  }

  std::pair<iterator, bool> insert(typename Base::value_type&& value) {
    auto key = value.first;
    auto result = values_.insert(std::move(value));
    if (result.second) {
      emit_write(key, result.first->second, trace_event_line());
    }
    return result;
  }

  template <typename... Args>
  std::pair<iterator, bool> emplace(Args&&... args) {
    auto result = values_.emplace(std::forward<Args>(args)...);
    if (result.second) {
      emit_write(result.first->first, result.first->second, trace_event_line());
    }
    return result;
  }

  std::size_t erase(const K& key) {
    const auto erased = values_.erase(key);
    if (erased > 0) {
      emit_keyed_mutate(key, "erase", trace_event_line(), mutation_args_json(key));
      emit_snapshot(trace_event_line());
    }
    return erased;
  }

  iterator erase(iterator position) {
    auto next = values_.erase(position);
    emit_mutate("erase", trace_event_line());
    emit_snapshot(trace_event_line());
    return next;
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void swap(UnorderedMap<K, V>& other) {
    values_.swap(other.values_);
    emit_mutate("swap", trace_event_line());
    other.emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
    other.emit_snapshot(trace_event_line());
  }

  void swap(std::unordered_map<K, V>& other) {
    values_.swap(other);
    emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
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
    emit_read(key, line, value_json, nullptr);
  }

  void emit_read(const K& key, int line, const std::string& value_json, const char* source) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key, source) +
      ",\"value\":" + value_json + "}",
      line
    );
    if (!path_prefix_json_.empty()) emit_snapshot(line);
  }

  void emit_iteration_bind_read(const K& key, const std::string& value_json, int line, const char* binding_name) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key) +
      ",\"value\":" + value_json +
      ",\"binding\":{\"kind\":\"iteration\",\"variable\":" + to_json(binding_name) + "}}",
      line
    );
    if (!path_prefix_json_.empty()) emit_snapshot(line);
  }

  void emit_write(const K& key, const V& value, int line) {
    emit_write(key, value, line, nullptr);
  }

  void emit_write(const K& key, const V& value, int line, const char* source) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key, source) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  template <typename InnerValue>
  void emit_nested_write(const K& key, std::size_t inner, const InnerValue& value, int line, const char* key_source = nullptr, const char* inner_source = nullptr) {
    if (!trace_) return;
    const std::string path = path_prefix_json_.empty()
      ? to_json(key) + "," + std::to_string(inner)
      : path_prefix_json_ + "," + to_json(key) + "," + std::to_string(inner);
    std::string source_segment;
    if ((key_source && *key_source) || (inner_source && *inner_source)) {
      source_segment = std::string(",\"indexSources\":[") +
        (path_prefix_json_.empty() ? "" : "null,") +
        ((key_source && *key_source) ? to_json(std::string(key_source)) : "null") +
        "," +
        ((inner_source && *inner_source) ? to_json(std::string(inner_source)) : "null") +
        "]";
    }
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":{\"variable\":" + to_json(name_) + ",\"path\":[" + path + "]" + source_segment + "}" +
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
      ",\"method\":" + to_json(method) + no_arg_mutation_args_json(method) + "}",
      line
    );
  }

  void emit_keyed_mutate(const K& key, const char* method, int line) {
    emit_keyed_mutate(key, method, line, "");
  }

  void emit_keyed_mutate(const K& key, const char* method, int line, const std::string& args_json) {
    emit_keyed_mutate(key, method, line, args_json, nullptr);
  }

  void emit_keyed_mutate(const K& key, const char* method, int line, const std::string& args_json, const char* source) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key, source) +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? "" : ",\"args\":" + args_json) + "}",
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
  Base& values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_key(const K& key) const {
    return target_json_key(key, nullptr);
  }

  std::string target_json_key(const K& key, const char* source) const {
    if (source && *source) {
      if (path_prefix_json_.empty()) return tracecode::target_json_key_with_index_source(name_, key, source);
      return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(key) + "],\"indexSources\":" + tracecode::index_sources_json(nullptr, source) + "}";
    }
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
  UnorderedMapValueRef(UnorderedMap<K, V>& owner, K key, const char* source = nullptr) : owner_(owner), key_(key), source_(source) {}

  V& get() {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null", source_);
    return owner_.values_[key_];
  }

  const V& get() const {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null", source_);
    return owner_.values_.at(key_);
  }

  operator V() {
    return get();
  }

  operator V() const {
    return get();
  }

  UnorderedMapValueRef& operator=(const V& value) {
    owner_.values_[key_] = value;
    owner_.emit_keyed_mutate(key_, "set", trace_event_line(), mutation_args_json(key_, value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  UnorderedMapValueRef& operator+=(const V& value) {
    owner_.values_[key_] += value;
    owner_.emit_keyed_mutate(key_, "update", trace_event_line(), mutation_args_json(value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  UnorderedMapValueRef& operator-=(const V& value) {
    owner_.values_[key_] -= value;
    owner_.emit_keyed_mutate(key_, "update", trace_event_line(), mutation_args_json(value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  UnorderedMapValueRef& operator*=(const V& value) {
    owner_.values_[key_] *= value;
    owner_.emit_keyed_mutate(key_, "update", trace_event_line(), mutation_args_json(value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  UnorderedMapValueRef& operator/=(const V& value) {
    owner_.values_[key_] /= value;
    owner_.emit_keyed_mutate(key_, "update", trace_event_line(), mutation_args_json(value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  UnorderedMapValueRef& operator--() {
    --owner_.values_[key_];
    owner_.emit_keyed_mutate(key_, "decrement", trace_event_line(), mutation_args_json(), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  V operator--(int) {
    V old = owner_.values_[key_]--;
    owner_.emit_keyed_mutate(key_, "decrement", trace_event_line(), mutation_args_json(), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return old;
  }

  UnorderedMapValueRef& operator++() {
    ++owner_.values_[key_];
    owner_.emit_keyed_mutate(key_, "increment", trace_event_line(), mutation_args_json(), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  V operator++(int) {
    V old = owner_.values_[key_]++;
    owner_.emit_keyed_mutate(key_, "increment", trace_event_line(), mutation_args_json(), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return old;
  }

  template <typename U = V>
  std::enable_if_t<is_std_vector<U>::value, void>
  push_back(const typename U::value_type& value) {
    const int line = trace_event_line();
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, line, present ? to_json(owner_.values_.at(key_)) : "null", source_);
    const auto inner_index = owner_.values_[key_].size();
    owner_.values_[key_].push_back(value);
    owner_.emit_keyed_mutate(key_, "push_back", line, std::string("[") + to_json(value) + "]", source_);
    owner_.emit_nested_write(key_, inner_index, owner_.values_[key_][inner_index], line, source_, nullptr);
    owner_.emit_snapshot(line);
  }

  template <typename... Args>
  decltype(auto) emplace_back(Args&&... args) {
    using Result = decltype(std::declval<V&>().emplace_back(std::forward<Args>(args)...));
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null", source_);
    if constexpr (std::is_void_v<Result>) {
      owner_.values_[key_].emplace_back(std::forward<Args>(args)...);
      owner_.emit_keyed_mutate(key_, "emplace_back", trace_event_line(), "", source_);
      owner_.emit_snapshot(trace_event_line());
    } else {
      decltype(auto) result = owner_.values_[key_].emplace_back(std::forward<Args>(args)...);
      owner_.emit_keyed_mutate(key_, "emplace_back", trace_event_line(), "", source_);
      owner_.emit_snapshot(trace_event_line());
      return result;
    }
  }

  template <typename Index, typename U = V>
  auto operator[](Index&& index) -> decltype(std::declval<U&>()[std::forward<Index>(index)]) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null", source_);
    return owner_.values_[key_][std::forward<Index>(index)];
  }

  template <typename Index, typename U = V>
  auto operator[](Index&& index) const -> decltype(std::declval<const U&>()[std::forward<Index>(index)]) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_.at(key_)[std::forward<Index>(index)];
  }

  template <typename Value, typename U = V>
  auto insert(Value&& value) -> decltype(std::declval<U&>().insert(std::forward<Value>(value))) {
    auto args_json = std::string("[") + to_json(value) + "]";
    auto result = owner_.values_[key_].insert(std::forward<Value>(value));
    owner_.emit_keyed_mutate(key_, "insert", trace_event_line(), args_json, source_);
    owner_.emit_snapshot(trace_event_line());
    return result;
  }

  template <typename Value, typename U = V>
  auto contains(const Value& value) const -> decltype(std::declval<const U&>().contains(value)) {
    return get().contains(value);
  }

  template <typename Value, typename U = V>
  auto count(const Value& value) const -> decltype(std::declval<const U&>().count(value)) {
    return get().count(value);
  }

  template <typename U = V>
  auto begin() -> decltype(std::declval<U&>().begin()) {
    return get().begin();
  }

  template <typename U = V>
  auto end() -> decltype(std::declval<U&>().end()) {
    return get().end();
  }

  template <typename U = V>
  auto begin() const -> decltype(std::declval<const U&>().begin()) {
    return get().begin();
  }

  template <typename U = V>
  auto end() const -> decltype(std::declval<const U&>().end()) {
    return get().end();
  }

  template <typename U = V>
  auto size() -> decltype(std::declval<U&>().size()) {
    return get().size();
  }

  template <typename U = V>
  auto size() const -> decltype(std::declval<const U&>().size()) {
    return get().size();
  }

  template <typename U = V>
  auto empty() -> decltype(std::declval<U&>().empty()) {
    return get().empty();
  }

  template <typename U = V>
  auto empty() const -> decltype(std::declval<const U&>().empty()) {
    return get().empty();
  }

 private:
  UnorderedMap<K, V>& owner_;
  K key_;
  const char* source_;
};

template <typename K, typename V>
std::string to_json(const UnorderedMapValueRef<K, V>& value) {
  V materialized = value;
  return to_json(materialized);
}

template <typename K, typename V, typename U>
bool operator==(const UnorderedMapValueRef<K, V>& left, const U& right) {
  V materialized = left;
  return materialized == right;
}

template <typename K, typename V>
bool operator==(const UnorderedMapValueRef<K, V>& left, const UnorderedMapValueRef<K, V>& right) {
  V leftValue = left;
  V rightValue = right;
  return leftValue == rightValue;
}

template <typename K, typename V, typename U>
bool operator==(const U& left, const UnorderedMapValueRef<K, V>& right) {
  V materialized = right;
  return left == materialized;
}

template <typename K, typename V, typename U>
bool operator!=(const UnorderedMapValueRef<K, V>& left, const U& right) {
  return !(left == right);
}

template <typename K, typename V, typename U>
bool operator!=(const U& left, const UnorderedMapValueRef<K, V>& right) {
  return !(left == right);
}

template <typename K, typename V>
std::string to_json(const UnorderedMap<K, V>& values) {
  return to_json(values.raw());
}

template <typename K, typename V>
class MapValueRef;

template <typename K, typename V>
class Map : public std::map<K, V> {
 public:
  using Base = std::map<K, V>;
  using key_type = K;
  using mapped_type = V;
  using iterator = typename Base::iterator;
  using const_iterator = typename Base::const_iterator;

  using Base::erase;
  using Base::insert;
  using Base::swap;

  Map() : Base(), values_(static_cast<Base&>(*this)), name_("map"), path_prefix_json_(""), trace_(false) {}

  Map(const Map& other)
      : Base(static_cast<const Base&>(other)),
        values_(static_cast<Base&>(*this)),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  Map(Map&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(static_cast<Base&>(*this)),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  Map& operator=(const Map& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Map& operator=(Map&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Map(const char* name, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Map(const char* name, const char* field, int line)
      : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Map(std::initializer_list<std::pair<const K, V>> values) : Base(values), values_(static_cast<Base&>(*this)), name_("map"), path_prefix_json_(""), trace_(false) {}

  Map(std::initializer_list<std::pair<const K, V>> values, const char* name, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Map(std::initializer_list<std::pair<const K, V>> values, const char* name, const char* field, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Map(const std::map<K, V>& values, const char* name, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) {
    emit_snapshot(line);
  }

  Map(const std::map<K, V>& values, const char* name, const char* field, int line)
      : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) {
    emit_snapshot(line);
  }

  Map& operator=(const std::map<K, V>& values) {
    values_ = values;
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Map& operator=(std::initializer_list<std::pair<const K, V>> values) {
    values_ = values;
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  std::size_t count(const K& key) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.count(key);
  }

  std::size_t count_with_index_source(const K& key, const char* source) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null", source);
    return values_.count(key);
  }

  bool contains(const K& key) const {
    return count(key) > 0;
  }

  iterator find(const K& key) {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.find(key);
  }

  const_iterator find(const K& key) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.find(key);
  }

  iterator find_with_index_source(const K& key, const char* source) {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null", source);
    return values_.find(key);
  }

  const_iterator find_with_index_source(const K& key, const char* source) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null", source);
    return values_.find(key);
  }

  iterator lower_bound(const K& key) {
    return values_.lower_bound(key);
  }

  const_iterator lower_bound(const K& key) const {
    return values_.lower_bound(key);
  }

  iterator upper_bound(const K& key) {
    return values_.upper_bound(key);
  }

  const_iterator upper_bound(const K& key) const {
    return values_.upper_bound(key);
  }

  std::pair<iterator, iterator> equal_range(const K& key) {
    return values_.equal_range(key);
  }

  std::pair<const_iterator, const_iterator> equal_range(const K& key) const {
    return values_.equal_range(key);
  }

  MapValueRef<K, V> operator[](const K& key) {
    return MapValueRef<K, V>(*this, key);
  }

  MapValueRef<K, V> with_index_source(const K& key, const char* source) {
    return MapValueRef<K, V>(*this, key, source);
  }

  MapValueRef<K, V> with_index_source(const K& key, const char* source, int line) {
    current_trace_line() = line;
    return MapValueRef<K, V>(*this, key, source);
  }

  V at(const K& key) const {
    emit_read(key, trace_event_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.at(key);
  }

  std::pair<iterator, bool> insert(const typename Base::value_type& value) {
    auto result = values_.insert(value);
    if (result.second) {
      emit_write(value.first, result.first->second, trace_event_line());
    }
    return result;
  }

  std::pair<iterator, bool> insert(typename Base::value_type&& value) {
    auto key = value.first;
    auto result = values_.insert(std::move(value));
    if (result.second) {
      emit_write(key, result.first->second, trace_event_line());
    }
    return result;
  }

  template <typename... Args>
  std::pair<iterator, bool> emplace(Args&&... args) {
    auto result = values_.emplace(std::forward<Args>(args)...);
    if (result.second) {
      emit_write(result.first->first, result.first->second, trace_event_line());
    }
    return result;
  }

  std::size_t erase(const K& key) {
    const auto erased = values_.erase(key);
    if (erased > 0) {
      emit_keyed_mutate(key, "erase", trace_event_line(), mutation_args_json(key));
      emit_snapshot(trace_event_line());
    }
    return erased;
  }

  iterator erase(iterator position) {
    auto next = values_.erase(position);
    emit_mutate("erase", trace_event_line());
    emit_snapshot(trace_event_line());
    return next;
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  void swap(Map<K, V>& other) {
    values_.swap(other.values_);
    emit_mutate("swap", trace_event_line());
    other.emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
    other.emit_snapshot(trace_event_line());
  }

  void swap(std::map<K, V>& other) {
    values_.swap(other);
    emit_mutate("swap", trace_event_line());
    emit_snapshot(trace_event_line());
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
    emit_read(key, line, value_json, nullptr);
  }

  void emit_read(const K& key, int line, const std::string& value_json, const char* source) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key, source) +
      ",\"value\":" + value_json + "}",
      line
    );
    if (!path_prefix_json_.empty()) emit_snapshot(line);
  }

  void emit_iteration_bind_read(const K& key, const std::string& value_json, int line, const char* binding_name) const {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key) +
      ",\"value\":" + value_json +
      ",\"binding\":{\"kind\":\"iteration\",\"variable\":" + to_json(binding_name) + "}}",
      line
    );
    if (!path_prefix_json_.empty()) emit_snapshot(line);
  }

  void emit_write(const K& key, const V& value, int line) {
    emit_write(key, value, line, nullptr);
  }

  void emit_write(const K& key, const V& value, int line, const char* source) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key, source) +
      ",\"value\":" + to_json(value) + "}",
      line
    );
    emit_snapshot(line);
  }

  template <typename InnerValue>
  void emit_nested_write(const K& key, std::size_t inner, const InnerValue& value, int line, const char* key_source = nullptr, const char* inner_source = nullptr) {
    if (!trace_) return;
    const std::string path = path_prefix_json_.empty()
      ? to_json(key) + "," + std::to_string(inner)
      : path_prefix_json_ + "," + to_json(key) + "," + std::to_string(inner);
    std::string source_segment;
    if ((key_source && *key_source) || (inner_source && *inner_source)) {
      source_segment = std::string(",\"indexSources\":[") +
        (path_prefix_json_.empty() ? "" : "null,") +
        ((key_source && *key_source) ? to_json(std::string(key_source)) : "null") +
        "," +
        ((inner_source && *inner_source) ? to_json(std::string(inner_source)) : "null") +
        "]";
    }
    write_trace_event_json(
      std::string("{\"kind\":\"write\",\"line\":") + std::to_string(line) +
      ",\"target\":{\"variable\":" + to_json(name_) + ",\"path\":[" + path + "]" + source_segment + "}" +
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
      ",\"method\":" + to_json(method) + no_arg_mutation_args_json(method) + "}",
      line
    );
  }

  void emit_keyed_mutate(const K& key, const char* method, int line) {
    emit_keyed_mutate(key, method, line, "");
  }

  void emit_keyed_mutate(const K& key, const char* method, int line, const std::string& args_json) {
    emit_keyed_mutate(key, method, line, args_json, nullptr);
  }

  void emit_keyed_mutate(const K& key, const char* method, int line, const std::string& args_json, const char* source) {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(key, source) +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? "" : ",\"args\":" + args_json) + "}",
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
  Base& values_;
  std::string name_;
  std::string path_prefix_json_;
  bool trace_;

  std::string target_json() const {
    if (path_prefix_json_.empty()) return tracecode::target_json(name_);
    return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "]}";
  }

  std::string target_json_key(const K& key) const {
    return target_json_key(key, nullptr);
  }

  std::string target_json_key(const K& key, const char* source) const {
    if (source && *source) {
      if (path_prefix_json_.empty()) return tracecode::target_json_key_with_index_source(name_, key, source);
      return std::string("{\"variable\":") + to_json(name_) + ",\"path\":[" + path_prefix_json_ + "," + to_json(key) + "],\"indexSources\":" + tracecode::index_sources_json(nullptr, source) + "}";
    }
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
  MapValueRef(Map<K, V>& owner, K key, const char* source = nullptr) : owner_(owner), key_(key), source_(source) {}

  V& get() {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null", source_);
    return owner_.values_[key_];
  }

  const V& get() const {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null", source_);
    return owner_.values_.at(key_);
  }

  operator V() {
    return get();
  }

  operator V() const {
    return get();
  }

  MapValueRef& operator=(const V& value) {
    owner_.values_[key_] = value;
    owner_.emit_keyed_mutate(key_, "set", trace_event_line(), mutation_args_json(key_, value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  MapValueRef& operator+=(const V& value) {
    owner_.values_[key_] += value;
    owner_.emit_keyed_mutate(key_, "update", trace_event_line(), mutation_args_json(value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  MapValueRef& operator-=(const V& value) {
    owner_.values_[key_] -= value;
    owner_.emit_keyed_mutate(key_, "update", trace_event_line(), mutation_args_json(value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  MapValueRef& operator*=(const V& value) {
    owner_.values_[key_] *= value;
    owner_.emit_keyed_mutate(key_, "update", trace_event_line(), mutation_args_json(value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  MapValueRef& operator/=(const V& value) {
    owner_.values_[key_] /= value;
    owner_.emit_keyed_mutate(key_, "update", trace_event_line(), mutation_args_json(value), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  MapValueRef& operator--() {
    --owner_.values_[key_];
    owner_.emit_keyed_mutate(key_, "decrement", trace_event_line(), mutation_args_json(), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  V operator--(int) {
    V old = owner_.values_[key_]--;
    owner_.emit_keyed_mutate(key_, "decrement", trace_event_line(), mutation_args_json(), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return old;
  }

  MapValueRef& operator++() {
    ++owner_.values_[key_];
    owner_.emit_keyed_mutate(key_, "increment", trace_event_line(), mutation_args_json(), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return *this;
  }

  V operator++(int) {
    V old = owner_.values_[key_]++;
    owner_.emit_keyed_mutate(key_, "increment", trace_event_line(), mutation_args_json(), source_);
    owner_.emit_write(key_, owner_.values_[key_], trace_event_line(), source_);
    return old;
  }

  template <typename U = V>
  std::enable_if_t<is_std_vector<U>::value, void>
  push_back(const typename U::value_type& value) {
    const int line = trace_event_line();
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, line, present ? to_json(owner_.values_.at(key_)) : "null", source_);
    const auto inner_index = owner_.values_[key_].size();
    owner_.values_[key_].push_back(value);
    owner_.emit_keyed_mutate(key_, "push_back", line, std::string("[") + to_json(value) + "]", source_);
    owner_.emit_nested_write(key_, inner_index, owner_.values_[key_][inner_index], line, source_, nullptr);
    owner_.emit_snapshot(line);
  }

  template <typename... Args>
  decltype(auto) emplace_back(Args&&... args) {
    using Result = decltype(std::declval<V&>().emplace_back(std::forward<Args>(args)...));
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null", source_);
    if constexpr (std::is_void_v<Result>) {
      owner_.values_[key_].emplace_back(std::forward<Args>(args)...);
      owner_.emit_keyed_mutate(key_, "emplace_back", trace_event_line(), "", source_);
      owner_.emit_snapshot(trace_event_line());
    } else {
      decltype(auto) result = owner_.values_[key_].emplace_back(std::forward<Args>(args)...);
      owner_.emit_keyed_mutate(key_, "emplace_back", trace_event_line(), "", source_);
      owner_.emit_snapshot(trace_event_line());
      return result;
    }
  }

  template <typename Index, typename U = V>
  auto operator[](Index&& index) -> decltype(std::declval<U&>()[std::forward<Index>(index)]) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null", source_);
    return owner_.values_[key_][std::forward<Index>(index)];
  }

  template <typename Index, typename U = V>
  auto operator[](Index&& index) const -> decltype(std::declval<const U&>()[std::forward<Index>(index)]) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, trace_event_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_.at(key_)[std::forward<Index>(index)];
  }

  template <typename Value, typename U = V>
  auto insert(Value&& value) -> decltype(std::declval<U&>().insert(std::forward<Value>(value))) {
    auto args_json = std::string("[") + to_json(value) + "]";
    auto result = owner_.values_[key_].insert(std::forward<Value>(value));
    owner_.emit_keyed_mutate(key_, "insert", trace_event_line(), args_json, source_);
    owner_.emit_snapshot(trace_event_line());
    return result;
  }

  template <typename Value, typename U = V>
  auto contains(const Value& value) const -> decltype(std::declval<const U&>().contains(value)) {
    return get().contains(value);
  }

  template <typename Value, typename U = V>
  auto count(const Value& value) const -> decltype(std::declval<const U&>().count(value)) {
    return get().count(value);
  }

  template <typename U = V>
  auto begin() -> decltype(std::declval<U&>().begin()) {
    return get().begin();
  }

  template <typename U = V>
  auto end() -> decltype(std::declval<U&>().end()) {
    return get().end();
  }

  template <typename U = V>
  auto begin() const -> decltype(std::declval<const U&>().begin()) {
    return get().begin();
  }

  template <typename U = V>
  auto end() const -> decltype(std::declval<const U&>().end()) {
    return get().end();
  }

  template <typename U = V>
  auto size() -> decltype(std::declval<U&>().size()) {
    return get().size();
  }

  template <typename U = V>
  auto size() const -> decltype(std::declval<const U&>().size()) {
    return get().size();
  }

  template <typename U = V>
  auto empty() -> decltype(std::declval<U&>().empty()) {
    return get().empty();
  }

  template <typename U = V>
  auto empty() const -> decltype(std::declval<const U&>().empty()) {
    return get().empty();
  }

 private:
  Map<K, V>& owner_;
  K key_;
  const char* source_;
};

template <typename K, typename V>
std::string to_json(const Map<K, V>& values) {
  return to_json(values.raw());
}

template <typename K, typename V>
inline KeyedRangeReadable<UnorderedMap<K, V>> keyed_range_readable(UnorderedMap<K, V>& container, int line, const char* key_binding_name = nullptr, const char* value_binding_name = nullptr) {
  return KeyedRangeReadable<UnorderedMap<K, V>>(container, line, key_binding_name, value_binding_name);
}

template <typename K, typename V>
inline KeyedRangeReadable<Map<K, V>> keyed_range_readable(Map<K, V>& container, int line, const char* key_binding_name = nullptr, const char* value_binding_name = nullptr) {
  return KeyedRangeReadable<Map<K, V>>(container, line, key_binding_name, value_binding_name);
}

template <typename K, typename V>
std::string to_json(const MapValueRef<K, V>& value) {
  V materialized = value;
  return to_json(materialized);
}

template <typename K, typename V, typename U>
bool operator==(const MapValueRef<K, V>& left, const U& right) {
  V materialized = left;
  return materialized == right;
}

template <typename K, typename V>
bool operator==(const MapValueRef<K, V>& left, const MapValueRef<K, V>& right) {
  V leftValue = left;
  V rightValue = right;
  return leftValue == rightValue;
}

template <typename K, typename V, typename U>
bool operator==(const U& left, const MapValueRef<K, V>& right) {
  V materialized = right;
  return left == materialized;
}

template <typename K, typename V, typename U>
bool operator!=(const MapValueRef<K, V>& left, const U& right) {
  return !(left == right);
}

template <typename K, typename V, typename U>
bool operator!=(const U& left, const MapValueRef<K, V>& right) {
  return !(left == right);
}

template <typename K, typename V, typename Compare, typename Allocator>
std::string to_json(const std::map<K, V, Compare, Allocator>& values) {
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
class Set : public std::set<T> {
 public:
  using Base = std::set<T>;
  using iterator = typename Base::iterator;
  using const_iterator = typename Base::const_iterator;
  using reverse_iterator = typename Base::reverse_iterator;
  using const_reverse_iterator = typename Base::const_reverse_iterator;

  using Base::erase;
  using Base::insert;
  using Base::swap;

  Set() : Base(), values_(static_cast<Base&>(*this)), name_("set"), path_prefix_json_(""), trace_(false) {}
  Set(const char* name, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Set(const char* name, const char* field, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Set(std::initializer_list<T> values) : Base(values), values_(static_cast<Base&>(*this)), name_("set"), path_prefix_json_(""), trace_(false) {}
  Set(const std::set<T>& values) : Base(values), values_(static_cast<Base&>(*this)), name_("set"), path_prefix_json_(""), trace_(false) {}
  Set(std::set<T>&& values) : Base(std::move(values)), values_(static_cast<Base&>(*this)), name_("set"), path_prefix_json_(""), trace_(false) {}

  Set(const Set<T>& other)
      : Base(static_cast<const Base&>(other)),
        values_(static_cast<Base&>(*this)),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  Set(Set<T>&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(static_cast<Base&>(*this)),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  Set(std::initializer_list<T> values, const char* name, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Set(std::initializer_list<T> values, const char* name, const char* field, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  Set(const std::set<T>& values, const char* name, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  Set(const std::set<T>& values, const char* name, const char* field, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  Set& operator=(const std::set<T>& values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Set& operator=(const Set<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Set& operator=(Set<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  Set& operator=(std::initializer_list<T> values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }

  std::size_t count(const T& value) const {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, trace_event_line());
    return values_.count(value);
  }

  bool contains(const T& value) const {
    return count(value) > 0;
  }

  iterator find(const T& value) {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, trace_event_line());
    return values_.find(value);
  }

  const_iterator find(const T& value) const {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, trace_event_line());
    return values_.find(value);
  }

  std::pair<iterator, bool> insert(const T& value) {
    auto args_json = mutation_args_json(value);
    auto result = values_.insert(value);
    emit_mutate("insert", trace_event_line(), args_json);
    if (result.second) emit_write(value, trace_event_line());
    return result;
  }

  std::pair<iterator, bool> insert(T&& value) {
    auto args_json = mutation_args_json(value);
    auto result = values_.insert(std::move(value));
    emit_mutate("insert", trace_event_line(), args_json);
    if (result.second) emit_write(*result.first, trace_event_line());
    return result;
  }

  template <typename InputIt>
  void insert(InputIt first, InputIt last) {
    values_.insert(first, last);
    emit_mutate("insert", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  template <typename... Args>
  std::pair<iterator, bool> emplace(Args&&... args) {
    auto args_json = mutation_args_json(args...);
    auto result = values_.emplace(std::forward<Args>(args)...);
    emit_mutate("emplace", trace_event_line(), args_json);
    if (result.second) emit_write(*result.first, trace_event_line());
    return result;
  }

  std::size_t erase(const T& value) {
    auto args_json = mutation_args_json(value);
    const auto erased = values_.erase(value);
    if (erased > 0) {
      emit_mutate_key(value, "erase", trace_event_line(), args_json);
      emit_snapshot(trace_event_line());
    }
    return erased;
  }

  iterator erase(iterator position) {
    auto next = values_.erase(position);
    emit_mutate("erase", trace_event_line());
    emit_snapshot(trace_event_line());
    return next;
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  iterator begin() { return values_.begin(); }
  iterator end() { return values_.end(); }
  const_iterator begin() const { return values_.begin(); }
  const_iterator end() const { return values_.end(); }
  reverse_iterator rbegin() { return values_.rbegin(); }
  reverse_iterator rend() { return values_.rend(); }
  const_reverse_iterator rbegin() const { return values_.rbegin(); }
  const_reverse_iterator rend() const { return values_.rend(); }

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

  void emit_mutate(const char* method, int line, const std::string& args_json = "") {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
      line
    );
  }

  void emit_mutate_key(const T& value, const char* method, int line, const std::string& args_json = "") {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(value) +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
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
  Base& values_;
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

template <typename T, typename Compare, typename Allocator>
std::string to_json(const std::set<T, Compare, Allocator>& values) {
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
class UnorderedSet : public std::unordered_set<T> {
 public:
  using Base = std::unordered_set<T>;
  using iterator = typename Base::iterator;
  using const_iterator = typename Base::const_iterator;

  using Base::erase;
  using Base::insert;
  using Base::swap;

  UnorderedSet() : Base(), values_(static_cast<Base&>(*this)), name_("set"), path_prefix_json_(""), trace_(false) {}
  UnorderedSet(const char* name, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  UnorderedSet(const char* name, const char* field, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  UnorderedSet(std::initializer_list<T> values) : Base(values), values_(static_cast<Base&>(*this)), name_("set"), path_prefix_json_(""), trace_(false) {}
  UnorderedSet(const std::unordered_set<T>& values) : Base(values), values_(static_cast<Base&>(*this)), name_("set"), path_prefix_json_(""), trace_(false) {}
  UnorderedSet(std::unordered_set<T>&& values) : Base(std::move(values)), values_(static_cast<Base&>(*this)), name_("set"), path_prefix_json_(""), trace_(false) {}

  UnorderedSet(const UnorderedSet<T>& other)
      : Base(static_cast<const Base&>(other)),
        values_(static_cast<Base&>(*this)),
        name_(other.name_),
        path_prefix_json_(other.path_prefix_json_),
        trace_(other.trace_) {}

  UnorderedSet(UnorderedSet<T>&& other)
      : Base(std::move(static_cast<Base&>(other))),
        values_(static_cast<Base&>(*this)),
        name_(std::move(other.name_)),
        path_prefix_json_(std::move(other.path_prefix_json_)),
        trace_(other.trace_) {}

  UnorderedSet(std::initializer_list<T> values, const char* name, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  UnorderedSet(std::initializer_list<T> values, const char* name, const char* field, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
  UnorderedSet(const std::unordered_set<T>& values, const char* name, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  UnorderedSet(const std::unordered_set<T>& values, const char* name, const char* field, int line) : Base(values), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }

  UnorderedSet& operator=(const std::unordered_set<T>& values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  UnorderedSet& operator=(const UnorderedSet<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  UnorderedSet& operator=(UnorderedSet<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  UnorderedSet& operator=(std::initializer_list<T> values) {
    Base::operator=(values);
    emit_write_field(trace_event_line());
    emit_snapshot(trace_event_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }
  void reserve(std::size_t count) {
    values_.reserve(count);
  }

  std::size_t count(const T& value) const {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, trace_event_line());
    return values_.count(value);
  }

  bool contains(const T& value) const {
    return count(value) > 0;
  }

  iterator find(const T& value) {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, trace_event_line());
    return values_.find(value);
  }

  const_iterator find(const T& value) const {
    const auto present = values_.count(value) > 0;
    emit_read(value, present, trace_event_line());
    return values_.find(value);
  }

  std::pair<iterator, bool> insert(const T& value) {
    auto args_json = mutation_args_json(value);
    auto result = values_.insert(value);
    emit_mutate("insert", trace_event_line(), args_json);
    if (result.second) emit_write(value, trace_event_line());
    return result;
  }

  std::pair<iterator, bool> insert(T&& value) {
    auto args_json = mutation_args_json(value);
    auto result = values_.insert(std::move(value));
    emit_mutate("insert", trace_event_line(), args_json);
    if (result.second) emit_write(*result.first, trace_event_line());
    return result;
  }

  template <typename InputIt>
  void insert(InputIt first, InputIt last) {
    values_.insert(first, last);
    emit_mutate("insert", trace_event_line());
    emit_snapshot(trace_event_line());
  }

  template <typename... Args>
  std::pair<iterator, bool> emplace(Args&&... args) {
    auto args_json = mutation_args_json(args...);
    auto result = values_.emplace(std::forward<Args>(args)...);
    emit_mutate("emplace", trace_event_line(), args_json);
    if (result.second) emit_write(*result.first, trace_event_line());
    return result;
  }

  std::size_t erase(const T& value) {
    auto args_json = mutation_args_json(value);
    const auto erased = values_.erase(value);
    if (erased > 0) {
      emit_mutate_key(value, "erase", trace_event_line(), args_json);
      emit_snapshot(trace_event_line());
    }
    return erased;
  }

  iterator erase(iterator position) {
    auto next = values_.erase(position);
    emit_mutate("erase", trace_event_line());
    emit_snapshot(trace_event_line());
    return next;
  }

  void clear() {
    values_.clear();
    emit_mutate("clear", trace_event_line());
    emit_snapshot(trace_event_line());
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

  void emit_mutate(const char* method, int line, const std::string& args_json = "") {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
      line
    );
  }

  void emit_mutate_key(const T& value, const char* method, int line, const std::string& args_json = "") {
    if (!trace_) return;
    write_trace_event_json(
      std::string("{\"kind\":\"mutate\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(value) +
      ",\"method\":" + to_json(method) +
      (args_json.empty() ? no_arg_mutation_args_json(method) : std::string(",\"args\":") + args_json) + "}",
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
  Base& values_;
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

template <typename T, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_set<T, Hash, Equal, Allocator>& values) {
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

inline void write_result_json_raw(const std::string& value_json) {
  std::string status = std::string("__TRACECODE_TRACE_STATUS__{\"traceLimitExceeded\":") +
    (trace_budget_exceeded() ? "true" : "false") +
    ",\"droppedEventCount\":" + std::to_string(dropped_trace_event_count());
  if (!trace_budget_timeout_reason().empty()) {
    status += ",\"timeoutReason\":" + to_json(trace_budget_timeout_reason());
  }
  status += "}\n";
  std::fputs(status.c_str(), stdout);
  std::string json = std::string("__TRACECODE_RESULT__") + value_json + "\n";
  std::fputs(json.c_str(), stdout);
}

template <typename T>
void write_result_json(const T& value) {
  write_result_json_raw(to_json(value));
}

inline void write_trace_event_json_raw(const std::string& event_json) {
  std::string json = std::string("__TRACECODE_EVENT__") + event_json + "\n";
  std::fputs(json.c_str(), stdout);
}

inline void configure_trace_budget(
  int max_events,
  bool hard_stop = false,
  int max_line_events = 0,
  int max_single_line_hits = 0,
  bool minimal_trace = false
) {
  trace_event_count() = 0;
  trace_line_event_count() = 0;
  trace_budget_exceeded() = false;
  trace_budget_timeout_reason().clear();
  dropped_trace_event_count() = 0;
  trace_line_hit_counts().clear();
  hard_stop_on_trace_budget() = hard_stop;
  trace_event_budget() = max_events > 0 ? max_events : 10000;
  trace_line_event_budget() = max_line_events > 0 ? max_line_events : 0;
  trace_single_line_hit_budget() = max_single_line_hits > 0 ? max_single_line_hits : 0;
  minimal_trace_enabled() = minimal_trace;
}

inline void stop_for_trace_budget(int line, const char* reason = "trace-limit", const char* message = "C++ trace budget exceeded") {
  trace_budget_exceeded() = true;
  if (trace_budget_timeout_reason().empty()) {
    trace_budget_timeout_reason() = reason;
  }
  dropped_trace_event_count() += 1;
  if (hard_stop_on_trace_budget()) {
    write_trace_event_json_raw(
      std::string("{\"kind\":\"timeout\",\"line\":") + std::to_string(line) +
      ",\"reason\":" + to_json(reason) +
      ",\"message\":" + to_json(message) + "}"
    );
    std::fflush(stdout);
    std::exit(124);
  }
}

inline bool check_trace_budget(int line) {
  if (trace_budget_exceeded()) {
    dropped_trace_event_count() += 1;
    return false;
  }
  if (trace_event_count() >= trace_event_budget()) {
    stop_for_trace_budget(line);
    return false;
  }
  return true;
}

inline bool check_line_trace_budget(int line) {
  if (trace_budget_exceeded()) {
    dropped_trace_event_count() += 1;
    return false;
  }
  trace_line_event_count() += 1;
  if (trace_line_event_budget() > 0 && trace_line_event_count() > trace_line_event_budget()) {
    stop_for_trace_budget(line, "line-limit", "C++ line event limit exceeded");
    return false;
  }
  int next_hits = trace_line_hit_counts()[line] + 1;
  trace_line_hit_counts()[line] = next_hits;
  if (trace_single_line_hit_budget() > 0 && next_hits > trace_single_line_hit_budget()) {
    stop_for_trace_budget(line, "single-line-limit", "C++ single-line hit limit exceeded");
    return false;
  }
  return true;
}

inline bool minimal_trace_suppresses_event(const std::string& event_json) {
  if (!minimal_trace_enabled()) return false;
  return event_json.find("\"kind\":\"snapshot\"") != std::string::npos ||
    event_json.find("\"kind\":\"read\"") != std::string::npos ||
    event_json.find("\"kind\":\"write\"") != std::string::npos ||
    event_json.find("\"kind\":\"mutate\"") != std::string::npos;
}

inline void write_trace_event_json(const std::string& event_json, int line) {
  if (minimal_trace_suppresses_event(event_json)) return;
  if (!check_trace_budget(line)) return;
  trace_event_count() += 1;
  write_trace_event_json_raw(event_json);
}

inline void set_current_trace_line(int line) {
  current_trace_line() = line;
}

inline void emit_post_line_frame(int line, const char* function_name) {
  set_current_trace_line(line);
  if (!check_line_trace_budget(line)) return;
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

namespace std {

template <typename T>
T min(const tracecode::VectorElementRef<T>& left, const T& right) {
  T materialized = left;
  return std::min(materialized, right);
}

template <typename T>
T min(const T& left, const tracecode::VectorElementRef<T>& right) {
  T materialized = right;
  return std::min(left, materialized);
}

template <typename T>
T max(const tracecode::VectorElementRef<T>& left, const T& right) {
  T materialized = left;
  return std::max(materialized, right);
}

template <typename T>
T max(const T& left, const tracecode::VectorElementRef<T>& right) {
  T materialized = right;
  return std::max(left, materialized);
}

template <typename T>
T min(const tracecode::NestedVectorElementRef<T>& left, const T& right) {
  T materialized = left;
  return std::min(materialized, right);
}

template <typename T>
T min(const T& left, const tracecode::NestedVectorElementRef<T>& right) {
  T materialized = right;
  return std::min(left, materialized);
}

template <typename T>
T max(const tracecode::NestedVectorElementRef<T>& left, const T& right) {
  T materialized = left;
  return std::max(materialized, right);
}

template <typename T>
T max(const T& left, const tracecode::NestedVectorElementRef<T>& right) {
  T materialized = right;
  return std::max(left, materialized);
}

template <typename T>
T min(const tracecode::VectorElementRef<T>& left, const tracecode::NestedVectorElementRef<T>& right) {
  T leftValue = left;
  T rightValue = right;
  return std::min(leftValue, rightValue);
}

template <typename T>
T min(const tracecode::NestedVectorElementRef<T>& left, const tracecode::VectorElementRef<T>& right) {
  T leftValue = left;
  T rightValue = right;
  return std::min(leftValue, rightValue);
}

template <typename T>
T max(const tracecode::VectorElementRef<T>& left, const tracecode::NestedVectorElementRef<T>& right) {
  T leftValue = left;
  T rightValue = right;
  return std::max(leftValue, rightValue);
}

template <typename T>
T max(const tracecode::NestedVectorElementRef<T>& left, const tracecode::VectorElementRef<T>& right) {
  T leftValue = left;
  T rightValue = right;
  return std::max(leftValue, rightValue);
}

template <typename K, typename V>
V min(const tracecode::UnorderedMapValueRef<K, V>& left, const V& right) {
  V materialized = left;
  return std::min(materialized, right);
}

template <typename K, typename V>
V min(const V& left, const tracecode::UnorderedMapValueRef<K, V>& right) {
  V materialized = right;
  return std::min(left, materialized);
}

template <typename K, typename V>
V max(const tracecode::UnorderedMapValueRef<K, V>& left, const V& right) {
  V materialized = left;
  return std::max(materialized, right);
}

template <typename K, typename V>
V max(const V& left, const tracecode::UnorderedMapValueRef<K, V>& right) {
  V materialized = right;
  return std::max(left, materialized);
}

template <typename K, typename V>
V min(const tracecode::MapValueRef<K, V>& left, const V& right) {
  V materialized = left;
  return std::min(materialized, right);
}

template <typename K, typename V>
V min(const V& left, const tracecode::MapValueRef<K, V>& right) {
  V materialized = right;
  return std::min(left, materialized);
}

template <typename K, typename V>
V max(const tracecode::MapValueRef<K, V>& left, const V& right) {
  V materialized = left;
  return std::max(materialized, right);
}

template <typename K, typename V>
V max(const V& left, const tracecode::MapValueRef<K, V>& right) {
  V materialized = right;
  return std::max(left, materialized);
}

template <typename T>
void swap(tracecode::VectorElementRef<T> left, tracecode::VectorElementRef<T> right) {
  T value = left;
  left = static_cast<T>(right);
  right = value;
}

template <typename T>
void swap(tracecode::NestedVectorElementRef<T> left, tracecode::NestedVectorElementRef<T> right) {
  T value = left;
  left = static_cast<T>(right);
  right = value;
}

template <typename CharT, typename Traits, typename T>
basic_ostream<CharT, Traits>& operator<<(basic_ostream<CharT, Traits>& stream, const tracecode::VectorElementRef<T>& value) {
  T materialized = value;
  return stream << materialized;
}

inline istream& getline(istream& input, tracecode::VectorElementRef<string> target, char delimiter) {
  string value;
  istream& result = std::getline(input, value, delimiter);
  target = value;
  return result;
}

inline istream& getline(istream& input, tracecode::VectorElementRef<string> target) {
  string value;
  istream& result = std::getline(input, value);
  target = value;
  return result;
}

}  // namespace std
