#include <string>
#include <variant>
#include <vector>

using Value = std::variant<std::string, int>;

std::string stringify(const Value& v) {
  return std::get<std::string>(v);
}

std::string solve(std::vector<Value>& values) {
  Value picked = values[0];
  return stringify(picked);
}
