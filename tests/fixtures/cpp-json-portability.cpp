#include "tracecode_runtime.hpp"

#include <cassert>

using tracecode::JsonValue;
using tracecode::object_get;
using tracecode::parse_json;
using tracecode::to_json;

static_assert(std::is_nothrow_default_constructible_v<JsonValue>);
static_assert(std::is_copy_constructible_v<JsonValue>);
static_assert(std::is_copy_assignable_v<JsonValue>);
static_assert(std::is_nothrow_move_constructible_v<JsonValue>);
static_assert(std::is_nothrow_move_assignable_v<JsonValue>);

int main() {
  JsonValue empty;
  assert(empty.is_null());
  assert(to_json(empty) == "null");
  assert(empty.array_values.empty() && empty.object_values.empty());

  // Keep insertion order, duplicate keys, mixed nesting, and empty containers.
  const std::string source =
      R"({"z":[{"label":"line\nquote\"","n":-2.5},true,false,null,[],{}],"a":{"inner":[1,2]},"z":3})";
  JsonValue original = parse_json(source);
  assert(to_json(original) == source);
  assert(original.object_values.size() == 3);
  assert(original.object_values[0].first == "z");
  assert(original.object_values[1].first == "a");
  assert(original.object_values[2].first == "z");
  assert(object_get(original, "z") == &original.object_values[0].second);
  assert(object_get(original, "missing") == nullptr);
  assert(tracecode::json_input_value(original, "missing", 1).kind == JsonValue::Kind::Object);

  JsonValue copied(original);
  copied.object_values[0].second.array_values[0].object_values[0].second.string_value = "changed";
  assert(to_json(original) == source);
  assert(to_json(copied) != source);

  JsonValue assigned = parse_json(R"({"replace":[0]})");
  assigned = original;
  assigned.object_values[1].second.object_values[0].second.array_values[0].number_value = 7;
  assert(to_json(original) == source);
  assert(to_json(assigned) != source);

  const std::string copied_source = to_json(copied);
  JsonValue moved(std::move(copied));
  assert(to_json(moved) == copied_source);
  copied = parse_json("[null]");
  assert(to_json(copied) == "[null]");

  const std::string assigned_source = to_json(assigned);
  JsonValue move_assigned = parse_json(R"({"replace":[0]})");
  move_assigned = std::move(assigned);
  assert(to_json(move_assigned) == assigned_source);
  assigned = JsonValue{};
  assert(assigned.is_null());

  // Reallocation exercises noexcept moves of recursive object/array values.
  std::vector<JsonValue> values;
  for (int index = 0; index < 32; ++index) values.push_back(original);
  for (const JsonValue& value : values) assert(to_json(value) == source);
  JsonValue expanded = original;
  for (int index = 0; index < 32; ++index) {
    expanded.object_values.emplace_back("nested", original);
    expanded.object_values[0].second.array_values.push_back(original);
  }
  const std::string expanded_source = to_json(expanded);
  assert(to_json(parse_json(expanded_source)) == expanded_source);
}
