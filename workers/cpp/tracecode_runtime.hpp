#pragma once

#include <any>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <deque>
#include <iomanip>
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

template <typename Node>
auto to_json_tree_like_node(Node* node, std::unordered_map<const void*, std::string>& refs) ->
  decltype(node->val, node->left, node->right, std::string()) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_ref_id(refs);
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
auto to_json_quad_like_node(Node* node, std::unordered_map<const void*, std::string>& refs) ->
  decltype(node->val, node->isLeaf, node->topLeft, node->topRight, node->bottomLeft, node->bottomRight, std::string()) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_ref_id(refs);
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
  const std::string id = tracecode_ref_id(refs);
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

template <typename Node>
auto to_json_list_like_node(Node* node, std::unordered_map<const void*, std::string>& refs) ->
  decltype(node->val, node->next, std::string()) {
  if (node == nullptr) return "null";
  const auto found = refs.find(node);
  if (found != refs.end()) {
    return std::string("{\"__ref__\":") + to_json(found->second) + "}";
  }
  const std::string id = tracecode_ref_id(refs);
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
std::enable_if_t<!std::is_arithmetic_v<T> && !std::is_pointer_v<T> && !std::is_convertible_v<T, std::string>, std::string>
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
std::enable_if_t<!std::is_arithmetic_v<T> && !std::is_pointer_v<T> && !std::is_convertible_v<T, std::string>, std::string>
to_json(const T&);

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
std::enable_if_t<!std::is_arithmetic_v<T> && !std::is_pointer_v<T> && !std::is_convertible_v<T, std::string>, std::string>
to_json(const T&) {
  return "{}";
}

template <typename T, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_set<T, Hash, Equal, Allocator>& values);

template <typename K, typename V, typename Hash, typename Equal, typename Allocator>
std::string to_json(const std::unordered_map<K, V, Hash, Equal, Allocator>& values);

template <typename K, typename V, typename Compare, typename Allocator>
std::string to_json(const std::map<K, V, Compare, Allocator>& values);

template <typename T, std::size_t Size>
std::string to_json(const std::array<T, Size>& values);

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

inline std::string target_json(const std::string& name, std::size_t outer, std::size_t inner) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + std::to_string(outer) + "," + std::to_string(inner) + "]}";
}

template <typename K>
inline std::string target_json_key(const std::string& name, const K& key) {
  return std::string("{\"variable\":") + to_json(name) + ",\"path\":[" + to_json(key) + "]}";
}

template <typename Container, typename Index>
inline auto trace_index_read(const Container& container, const std::string& name, Index index, int line) {
  const auto& value = container[index];
  if (!minimal_trace_enabled() && check_trace_budget(line)) {
    trace_event_count() += 1;
    write_trace_event_json_raw(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json_key(name, index) +
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
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Vector& operator=(const Vector<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Vector& operator=(Vector<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Vector& operator=(std::initializer_list<T> values) {
    Base::operator=(values);
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }
  std::size_t capacity() const { return values_.capacity(); }

  void reserve(std::size_t count) {
    values_.reserve(count);
    emit_mutate("reserve", current_trace_line());
  }

  template <typename... Args>
  T& emplace_back(Args&&... args) {
    emit_receiver_read(current_trace_line());
    T& result = values_.emplace_back(std::forward<Args>(args)...);
    emit_mutate("emplace_back", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

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
    emit_receiver_read(current_trace_line());
    values_.push_back(value);
    emit_mutate("push_back", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void push_back(T&& value) {
    emit_receiver_read(current_trace_line());
    values_.push_back(std::move(value));
    emit_mutate("push_back", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void pop_back() {
    emit_receiver_read(current_trace_line());
    values_.pop_back();
    emit_mutate("pop_back", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void resize(std::size_t count) {
    emit_receiver_read(current_trace_line());
    values_.resize(count);
    emit_mutate("resize", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void resize(std::size_t count, const T& value) {
    emit_receiver_read(current_trace_line());
    values_.resize(count, value);
    emit_mutate("resize", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void clear() {
    emit_receiver_read(current_trace_line());
    values_.clear();
    emit_mutate("clear", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void swap(Vector<T>& other) {
    emit_receiver_read(current_trace_line());
    other.emit_receiver_read(current_trace_line());
    values_.swap(other.values_);
    emit_mutate("swap", current_trace_line());
    other.emit_mutate("swap", current_trace_line());
    emit_snapshot(current_trace_line());
    other.emit_snapshot(current_trace_line());
  }

  void swap(std::vector<T>& other) {
    emit_receiver_read(current_trace_line());
    values_.swap(other);
    emit_mutate("swap", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void assign(std::size_t count, const T& value) {
    emit_receiver_read(current_trace_line());
    values_.assign(count, value);
    emit_mutate("assign", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void assign(std::initializer_list<T> values) {
    emit_receiver_read(current_trace_line());
    values_.assign(values);
    emit_mutate("assign", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  iterator insert(const_iterator position, const T& value) {
    emit_receiver_read(current_trace_line());
    auto result = values_.insert(position, value);
    emit_mutate("insert", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  iterator insert(const_iterator position, T&& value) {
    emit_receiver_read(current_trace_line());
    auto result = values_.insert(position, std::move(value));
    emit_mutate("insert", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  iterator insert(const_iterator position, std::size_t count, const T& value) {
    emit_receiver_read(current_trace_line());
    auto result = values_.insert(position, count, value);
    emit_mutate("insert", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  template <typename InputIt>
  iterator insert(const_iterator position, InputIt first, InputIt last) {
    emit_receiver_read(current_trace_line());
    auto result = values_.insert(position, first, last);
    emit_mutate("insert", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  iterator erase(const_iterator position) {
    emit_receiver_read(current_trace_line());
    auto result = values_.erase(position);
    emit_mutate("erase", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  iterator erase(const_iterator first, const_iterator last) {
    emit_receiver_read(current_trace_line());
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

  void emit_receiver_read(int line) const {
    if (!trace_ || path_prefix_json_.empty()) return;
    write_trace_event_json(
      std::string("{\"kind\":\"read\",\"line\":") + std::to_string(line) +
      ",\"target\":" + target_json() +
      ",\"value\":" + to_json(values_) + "}",
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
};

template <typename T>
class VectorElementRef {
 public:
  VectorElementRef(Vector<T>& owner, std::size_t index) : owner_(owner), index_(index) {}

  T& get() {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_];
  }

  const T& get() const {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_];
  }

  operator T() const {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_];
  }

  VectorElementRef& operator=(const T& value) {
    owner_.values_[index_] = value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator=(const VectorElementRef& other) {
    T value = other;
    return (*this = value);
  }

  VectorElementRef& operator+=(const T& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_] += value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator-=(const T& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_] -= value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator*=(const T& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_] *= value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator/=(const T& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_] /= value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator%=(const T& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_] %= value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator^=(const T& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_] ^= value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator|=(const T& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_] |= value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator&=(const T& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_] &= value;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  VectorElementRef& operator++() {
    owner_.emit_read(index_, current_trace_line());
    ++owner_.values_[index_];
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  T operator++(int) {
    owner_.emit_read(index_, current_trace_line());
    T old = owner_.values_[index_]++;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return old;
  }

  VectorElementRef& operator--() {
    owner_.emit_read(index_, current_trace_line());
    --owner_.values_[index_];
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
    return *this;
  }

  T operator--(int) {
    owner_.emit_read(index_, current_trace_line());
    T old = owner_.values_[index_]--;
    owner_.emit_write(index_, owner_.values_[index_], current_trace_line());
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
    auto result = owner_.values_[index_].insert(std::forward<Value>(value));
    owner_.emit_indexed_mutate(index_, "insert", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
    return result;
  }

  template <typename... Args, typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  assign(Args&&... args) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_].assign(std::forward<Args>(args)...);
    owner_.emit_indexed_mutate(index_, "assign", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
  }

  template <typename Value, typename U = T>
  auto contains(const Value& value) const -> decltype(std::declval<const U&>().contains(value)) {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].contains(value);
  }

  template <typename Value, typename U = T>
  auto count(const Value& value) const -> decltype(std::declval<const U&>().count(value)) {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].count(value);
  }

  template <typename Value, typename U = T>
  auto find(const Value& value) -> decltype(std::declval<U&>().find(value)) {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].find(value);
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
  std::enable_if_t<is_std_vector<U>::value, typename U::const_reference>
  operator[](std::size_t innerIndex) const {
    owner_.emit_nested_read(index_, innerIndex, current_trace_line());
    return owner_.values_[index_][innerIndex];
  }

  template <typename U = T>
  std::enable_if_t<is_std_string<U>::value, char>
  operator[](std::size_t innerIndex) {
    owner_.emit_string_char_read(index_, innerIndex, current_trace_line());
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
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_][key];
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, void>
  push_back(const typename U::value_type& value) {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_].push_back(value);
    owner_.emit_indexed_mutate(index_, "push_back", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
  }

  template <typename Value, typename U = T>
  auto push_back(Value&& value) -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<U&>().push_back(std::forward<Value>(value)), void())> {
    owner_.emit_read(index_, current_trace_line());
    owner_.values_[index_].push_back(std::forward<Value>(value));
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
  std::enable_if_t<is_std_vector<U>::value, typename U::reference>
  front() {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].front();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_reference>
  front() const {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].front();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::reference>
  back() {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].back();
  }

  template <typename U = T>
  std::enable_if_t<is_std_vector<U>::value, typename U::const_reference>
  back() const {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].back();
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
  auto begin() -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<U&>().begin())> {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].begin();
  }

  template <typename U = T>
  auto end() -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<U&>().end())> {
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

  template <typename U = T>
  auto begin() const -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<const U&>().begin())> {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].begin();
  }

  template <typename U = T>
  auto end() const -> std::enable_if_t<!is_std_vector<U>::value, decltype(std::declval<const U&>().end())> {
    return owner_.values_[index_].end();
  }

  template <typename U = T>
  auto has_value() const -> decltype(std::declval<const U&>().has_value()) {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].has_value();
  }

  template <typename U = T>
  auto value() -> decltype(std::declval<U&>().value()) {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].value();
  }

  template <typename U = T>
  auto value() const -> decltype(std::declval<const U&>().value()) {
    owner_.emit_read(index_, current_trace_line());
    return owner_.values_[index_].value();
  }

 private:
  Vector<T>& owner_;
  std::size_t index_;
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

  operator T() const {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_];
  }

  NestedVectorElementRef& operator=(const T& value) {
    owner_.values_[outer_][inner_] = value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator=(const NestedVectorElementRef& other) {
    T value = other;
    return (*this = value);
  }

  NestedVectorElementRef& operator+=(const T& value) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    owner_.values_[outer_][inner_] += value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator-=(const T& value) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    owner_.values_[outer_][inner_] -= value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator*=(const T& value) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    owner_.values_[outer_][inner_] *= value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator/=(const T& value) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    owner_.values_[outer_][inner_] /= value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator%=(const T& value) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    owner_.values_[outer_][inner_] %= value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator^=(const T& value) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    owner_.values_[outer_][inner_] ^= value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator|=(const T& value) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    owner_.values_[outer_][inner_] |= value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator&=(const T& value) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    owner_.values_[outer_][inner_] &= value;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  NestedVectorElementRef& operator++() {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    ++owner_.values_[outer_][inner_];
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  T operator++(int) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    T old = owner_.values_[outer_][inner_]++;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return old;
  }

  NestedVectorElementRef& operator--() {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    --owner_.values_[outer_][inner_];
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return *this;
  }

  T operator--(int) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    T old = owner_.values_[outer_][inner_]--;
    owner_.emit_nested_write(outer_, inner_, owner_.values_[outer_][inner_], current_trace_line());
    return old;
  }

  template <typename Index, typename U = T>
  auto operator[](Index index) -> decltype(std::declval<U&>()[index]) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_][index];
  }

  template <typename Value, typename U = T>
  auto insert(Value&& value) -> decltype(std::declval<U&>().insert(std::forward<Value>(value))) {
    auto result = owner_.values_[outer_][inner_].insert(std::forward<Value>(value));
    owner_.emit_indexed_mutate(outer_, "insert", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
    return result;
  }

  template <typename InputIt, typename U = T>
  auto insert(InputIt first, InputIt last) -> decltype(std::declval<U&>().insert(first, last), void()) {
    owner_.values_[outer_][inner_].insert(first, last);
    owner_.emit_indexed_mutate(outer_, "insert", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
  }

  template <typename Value, typename U = T>
  auto contains(const Value& value) const -> decltype(std::declval<const U&>().contains(value)) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_].contains(value);
  }

  template <typename Value, typename U = T>
  auto count(const Value& value) const -> decltype(std::declval<const U&>().count(value)) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_].count(value);
  }

  template <typename Value, typename U = T>
  auto find(const Value& value) -> decltype(std::declval<U&>().find(value)) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_].find(value);
  }

  template <typename Value, typename U = T>
  auto find(const Value& value) const -> decltype(std::declval<const U&>().find(value)) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_].find(value);
  }

  template <typename U = T>
  auto begin() -> decltype(std::declval<U&>().begin()) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_].begin();
  }

  template <typename U = T>
  auto end() -> decltype(std::declval<U&>().end()) {
    return owner_.values_[outer_][inner_].end();
  }

  template <typename U = T>
  auto begin() const -> decltype(std::declval<const U&>().begin()) {
    owner_.emit_nested_read(outer_, inner_, current_trace_line());
    return owner_.values_[outer_][inner_].begin();
  }

  template <typename U = T>
  auto end() const -> decltype(std::declval<const U&>().end()) {
    return owner_.values_[outer_][inner_].end();
  }

 private:
  Vector<std::vector<T>>& owner_;
  std::size_t outer_;
  std::size_t inner_;
};

template <typename Map>
class NestedMapElementRef {
 public:
  using key_type = typename Map::key_type;
  using mapped_type = typename Map::mapped_type;

  NestedMapElementRef(Vector<Map>& owner, std::size_t outer, const key_type& key)
      : owner_(owner), outer_(outer), key_(key) {}

  operator mapped_type() const {
    owner_.emit_nested_key_read(outer_, key_, current_trace_line());
    return owner_.values_[outer_][key_];
  }

  NestedMapElementRef& operator=(const mapped_type& value) {
    owner_.values_[outer_][key_] = value;
    owner_.emit_nested_key_write(outer_, key_, owner_.values_[outer_][key_], current_trace_line());
    return *this;
  }

  NestedMapElementRef& operator+=(const mapped_type& value) {
    owner_.emit_nested_key_read(outer_, key_, current_trace_line());
    owner_.values_[outer_][key_] += value;
    owner_.emit_nested_key_write(outer_, key_, owner_.values_[outer_][key_], current_trace_line());
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
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Deque& operator=(const Deque<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Deque& operator=(Deque<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Deque& operator=(std::initializer_list<T> values) {
    Base::operator=(values);
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

  void push_back(T&& value) {
    values_.push_back(std::move(value));
    emit_mutate("push_back", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void push_front(const T& value) {
    values_.push_front(value);
    emit_mutate("push_front", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void push_front(T&& value) {
    values_.push_front(std::move(value));
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
    emit_snapshot(current_trace_line());
    return *this;
  }

  Queue& operator=(Queue<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_snapshot(current_trace_line());
    return *this;
  }

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

  void push(T&& value) {
    values_.push_back(std::move(value));
    emit_mutate("push", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  template <typename... Args>
  T& emplace(Args&&... args) {
    T& result = values_.emplace_back(std::forward<Args>(args)...);
    emit_mutate("emplace", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  void pop() {
    values_.pop_front();
    emit_mutate("pop", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void swap(Queue<T>& other) {
    Base::swap(other);
    emit_mutate("swap", current_trace_line());
    other.emit_mutate("swap", current_trace_line());
    emit_snapshot(current_trace_line());
    other.emit_snapshot(current_trace_line());
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
  Container& values_;
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

template <typename T, typename Container = std::vector<T>, typename Compare = std::less<T>>
class PriorityQueue : public std::priority_queue<T, Container, Compare> {
 public:
  using Base = std::priority_queue<T, Container, Compare>;

  using Base::swap;

  PriorityQueue() : Base(), values_(static_cast<Base&>(*this)), name_("priority_queue"), path_prefix_json_(""), trace_(false) {}
  PriorityQueue(const char* name, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(""), trace_(true) { emit_snapshot(line); }
  PriorityQueue(const char* name, const char* field, int line) : Base(), values_(static_cast<Base&>(*this)), name_(name), path_prefix_json_(to_json(field)), trace_(true) { emit_snapshot(line); }
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
    emit_snapshot(current_trace_line());
    return *this;
  }

  PriorityQueue& operator=(PriorityQueue<T, Container, Compare>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_snapshot(current_trace_line());
    return *this;
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

  void push(T&& value) {
    values_.push(std::move(value));
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

  void swap(PriorityQueue<T, Container, Compare>& other) {
    Base::swap(other);
    emit_mutate("swap", current_trace_line());
    other.emit_mutate("swap", current_trace_line());
    emit_snapshot(current_trace_line());
    other.emit_snapshot(current_trace_line());
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
    emit_snapshot(current_trace_line());
    return *this;
  }

  Stack& operator=(Stack<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_snapshot(current_trace_line());
    return *this;
  }

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

  void push(T&& value) {
    values_.push_back(std::move(value));
    emit_mutate("push", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  template <typename... Args>
  T& emplace(Args&&... args) {
    T& result = values_.emplace_back(std::forward<Args>(args)...);
    emit_mutate("emplace", current_trace_line());
    emit_snapshot(current_trace_line());
    return result;
  }

  void pop() {
    values_.pop_back();
    emit_mutate("pop", current_trace_line());
    emit_snapshot(current_trace_line());
  }

  void swap(Stack<T>& other) {
    Base::swap(other);
    emit_mutate("swap", current_trace_line());
    other.emit_mutate("swap", current_trace_line());
    emit_snapshot(current_trace_line());
    other.emit_snapshot(current_trace_line());
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
  Container& values_;
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
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  UnorderedMap& operator=(const UnorderedMap<K, V>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  UnorderedMap& operator=(UnorderedMap<K, V>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  UnorderedMap& operator=(std::initializer_list<std::pair<const K, V>> values) {
    Base::operator=(values);
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }
  void reserve(std::size_t count) {
    values_.reserve(count);
    emit_mutate("reserve", current_trace_line());
  }

  void max_load_factor(float value) {
    values_.max_load_factor(value);
    emit_mutate("max_load_factor", current_trace_line());
  }

  float max_load_factor() const {
    return values_.max_load_factor();
  }

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

  std::pair<iterator, bool> insert(const typename Base::value_type& value) {
    auto result = values_.insert(value);
    if (result.second) {
      emit_write(value.first, result.first->second, current_trace_line());
    }
    return result;
  }

  std::pair<iterator, bool> insert(typename Base::value_type&& value) {
    auto key = value.first;
    auto result = values_.insert(std::move(value));
    if (result.second) {
      emit_write(key, result.first->second, current_trace_line());
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

  void swap(UnorderedMap<K, V>& other) {
    values_.swap(other.values_);
    emit_mutate("swap", current_trace_line());
    other.emit_mutate("swap", current_trace_line());
    emit_snapshot(current_trace_line());
    other.emit_snapshot(current_trace_line());
  }

  void swap(std::unordered_map<K, V>& other) {
    values_.swap(other);
    emit_mutate("swap", current_trace_line());
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
  Base& values_;
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

  V& get() {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_[key_];
  }

  const V& get() const {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
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
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  UnorderedMapValueRef& operator+=(const V& value) {
    owner_.values_[key_] += value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  UnorderedMapValueRef& operator-=(const V& value) {
    owner_.values_[key_] -= value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  UnorderedMapValueRef& operator*=(const V& value) {
    owner_.values_[key_] *= value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  UnorderedMapValueRef& operator/=(const V& value) {
    owner_.values_[key_] /= value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  UnorderedMapValueRef& operator--() {
    --owner_.values_[key_];
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  V operator--(int) {
    V old = owner_.values_[key_]--;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return old;
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

  template <typename... Args>
  decltype(auto) emplace_back(Args&&... args) {
    using Result = decltype(std::declval<V&>().emplace_back(std::forward<Args>(args)...));
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    if constexpr (std::is_void_v<Result>) {
      owner_.values_[key_].emplace_back(std::forward<Args>(args)...);
      owner_.emit_keyed_mutate(key_, "emplace_back", current_trace_line());
      owner_.emit_snapshot(current_trace_line());
    } else {
      decltype(auto) result = owner_.values_[key_].emplace_back(std::forward<Args>(args)...);
      owner_.emit_keyed_mutate(key_, "emplace_back", current_trace_line());
      owner_.emit_snapshot(current_trace_line());
      return result;
    }
  }

  template <typename Index, typename U = V>
  auto operator[](Index&& index) -> decltype(std::declval<U&>()[std::forward<Index>(index)]) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_[key_][std::forward<Index>(index)];
  }

  template <typename Index, typename U = V>
  auto operator[](Index&& index) const -> decltype(std::declval<const U&>()[std::forward<Index>(index)]) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_.at(key_)[std::forward<Index>(index)];
  }

  template <typename Value, typename U = V>
  auto insert(Value&& value) -> decltype(std::declval<U&>().insert(std::forward<Value>(value))) {
    auto result = owner_.values_[key_].insert(std::forward<Value>(value));
    owner_.emit_keyed_mutate(key_, "insert", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
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
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Map& operator=(Map&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
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

  V at(const K& key) const {
    emit_read(key, current_trace_line(), values_.count(key) ? to_json(values_.at(key)) : "null");
    return values_.at(key);
  }

  std::pair<iterator, bool> insert(const typename Base::value_type& value) {
    auto result = values_.insert(value);
    if (result.second) {
      emit_write(value.first, result.first->second, current_trace_line());
    }
    return result;
  }

  std::pair<iterator, bool> insert(typename Base::value_type&& value) {
    auto key = value.first;
    auto result = values_.insert(std::move(value));
    if (result.second) {
      emit_write(key, result.first->second, current_trace_line());
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

  void swap(Map<K, V>& other) {
    values_.swap(other.values_);
    emit_mutate("swap", current_trace_line());
    other.emit_mutate("swap", current_trace_line());
    emit_snapshot(current_trace_line());
    other.emit_snapshot(current_trace_line());
  }

  void swap(std::map<K, V>& other) {
    values_.swap(other);
    emit_mutate("swap", current_trace_line());
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
  Base& values_;
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

  V& get() {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_[key_];
  }

  const V& get() const {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
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
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  MapValueRef& operator+=(const V& value) {
    owner_.values_[key_] += value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  MapValueRef& operator-=(const V& value) {
    owner_.values_[key_] -= value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  MapValueRef& operator*=(const V& value) {
    owner_.values_[key_] *= value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  MapValueRef& operator/=(const V& value) {
    owner_.values_[key_] /= value;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  MapValueRef& operator--() {
    --owner_.values_[key_];
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return *this;
  }

  V operator--(int) {
    V old = owner_.values_[key_]--;
    owner_.emit_write(key_, owner_.values_[key_], current_trace_line());
    return old;
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

  template <typename U = V>
  std::enable_if_t<is_std_vector<U>::value, void>
  push_back(const typename U::value_type& value) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    owner_.values_[key_].push_back(value);
    owner_.emit_keyed_mutate(key_, "push_back", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
  }

  template <typename... Args>
  decltype(auto) emplace_back(Args&&... args) {
    using Result = decltype(std::declval<V&>().emplace_back(std::forward<Args>(args)...));
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    if constexpr (std::is_void_v<Result>) {
      owner_.values_[key_].emplace_back(std::forward<Args>(args)...);
      owner_.emit_keyed_mutate(key_, "emplace_back", current_trace_line());
      owner_.emit_snapshot(current_trace_line());
    } else {
      decltype(auto) result = owner_.values_[key_].emplace_back(std::forward<Args>(args)...);
      owner_.emit_keyed_mutate(key_, "emplace_back", current_trace_line());
      owner_.emit_snapshot(current_trace_line());
      return result;
    }
  }

  template <typename Index, typename U = V>
  auto operator[](Index&& index) -> decltype(std::declval<U&>()[std::forward<Index>(index)]) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_[key_][std::forward<Index>(index)];
  }

  template <typename Index, typename U = V>
  auto operator[](Index&& index) const -> decltype(std::declval<const U&>()[std::forward<Index>(index)]) {
    const bool present = owner_.values_.count(key_) > 0;
    owner_.emit_read(key_, current_trace_line(), present ? to_json(owner_.values_.at(key_)) : "null");
    return owner_.values_.at(key_)[std::forward<Index>(index)];
  }

  template <typename Value, typename U = V>
  auto insert(Value&& value) -> decltype(std::declval<U&>().insert(std::forward<Value>(value))) {
    auto result = owner_.values_[key_].insert(std::forward<Value>(value));
    owner_.emit_keyed_mutate(key_, "insert", current_trace_line());
    owner_.emit_snapshot(current_trace_line());
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
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Set& operator=(const Set<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Set& operator=(Set<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  Set& operator=(std::initializer_list<T> values) {
    Base::operator=(values);
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

  std::pair<iterator, bool> insert(T&& value) {
    auto result = values_.insert(std::move(value));
    if (result.second) emit_write(*result.first, current_trace_line());
    return result;
  }

  template <typename InputIt>
  void insert(InputIt first, InputIt last) {
    values_.insert(first, last);
    emit_mutate("insert", current_trace_line());
    emit_snapshot(current_trace_line());
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
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  UnorderedSet& operator=(const UnorderedSet<T>& other) {
    if (this == &other) return *this;
    Base::operator=(static_cast<const Base&>(other));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  UnorderedSet& operator=(UnorderedSet<T>&& other) {
    if (this == &other) return *this;
    Base::operator=(std::move(static_cast<Base&>(other)));
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  UnorderedSet& operator=(std::initializer_list<T> values) {
    Base::operator=(values);
    emit_write_field(current_trace_line());
    emit_snapshot(current_trace_line());
    return *this;
  }

  std::size_t size() const { return values_.size(); }
  bool empty() const { return values_.empty(); }
  void reserve(std::size_t count) {
    values_.reserve(count);
    emit_mutate("reserve", current_trace_line());
  }

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

  std::pair<iterator, bool> insert(T&& value) {
    auto result = values_.insert(std::move(value));
    if (result.second) emit_write(*result.first, current_trace_line());
    return result;
  }

  template <typename InputIt>
  void insert(InputIt first, InputIt last) {
    values_.insert(first, last);
    emit_mutate("insert", current_trace_line());
    emit_snapshot(current_trace_line());
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
    event_json.find("\"kind\":\"mutate\"") != std::string::npos ||
    event_json.find("\"kind\":\"control\"") != std::string::npos;
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
