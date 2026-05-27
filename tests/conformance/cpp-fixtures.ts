export type CppConformanceEntryStyle =
  | 'solution_instance_method'
  | 'solution_static_method'
  | 'helper_methods'
  | 'private_state'
  | 'top_level_types'
  | 'nested_types';

export interface CppConformanceFixture {
  id: string;
  title: string;
  entryStyle: CppConformanceEntryStyle;
  methodName: string;
  source: string;
  input: Record<string, unknown>;
  expectedReturn: unknown;
  expectedMutations: Record<string, unknown>;
  expectedHarnessOutput?: unknown;
  coverage: string[];
  notes: string;
}

export const cppConformanceFixtures: CppConformanceFixture[] = [
  {
    id: 'cpp_const_vector_sum',
    title: 'Const Vector Sum',
    entryStyle: 'solution_instance_method',
    methodName: 'sumVector',
    source: String.raw`#include <vector>

class Solution {
public:
    int sumVector(const std::vector<int>& nums) {
        int total = 0;
        for (int x : nums) total += x;
        return total;
    }
};
`,
    input: { nums: [1, 2, 3, 4] },
    expectedReturn: 10,
    expectedMutations: {},
    coverage: ['vector', 'const_reference', 'primitive_return'],
    notes: 'Stresses invocation with a const vector reference without mutating input.',
  },
  {
    id: 'cpp_nested_pair_sum',
    title: 'Nested Pair Sum',
    entryStyle: 'nested_types',
    methodName: 'sumPair',
    source: String.raw`#include <vector>

class Solution {
public:
    struct Pair {
        int a = 0;
        int b = 0;
    };

    int sumPair(const Pair& p) {
        return p.a + p.b;
    }
};
`,
    input: { p: { a: 4, b: 7 } },
    expectedReturn: 11,
    expectedMutations: {},
    coverage: ['nested_struct', 'custom_object_parameter', 'const_reference'],
    notes: 'Stresses hydration of a nested custom object passed by const reference.',
  },
  {
    id: 'cpp_nested_point_return',
    title: 'Nested Point Return',
    entryStyle: 'nested_types',
    methodName: 'makePoint',
    source: String.raw`#include <string>

struct Solution {
    struct Point {
        int x = 0;
        int y = 0;
    };

    Point makePoint(int x, int y) {
        Point p;
        p.x = x;
        p.y = y;
        return p;
    }
};
`,
    input: { x: 3, y: -2 },
    expectedReturn: { x: 3, y: -2 },
    expectedMutations: {},
    coverage: ['nested_struct', 'custom_object_return', 'multiple_arguments'],
    notes: 'Stresses serialization of a nested custom object returned by value.',
  },
  {
    id: 'cpp_mutate_top_level_box',
    title: 'Mutate Top-Level Box',
    entryStyle: 'top_level_types',
    methodName: 'incrementBox',
    source: String.raw`#include <string>

struct Box {
    int value = 0;
};

class Solution {
public:
    int incrementBox(Box& box, int delta) {
        box.value += delta;
        return box.value;
    }
};
`,
    input: { box: { value: 10 }, delta: 5 },
    expectedReturn: 15,
    expectedMutations: { box: { value: 15 } },
    coverage: ['top_level_struct', 'custom_object_parameter', 'mutable_reference', 'multiple_arguments'],
    notes: 'Stresses mutation tracking for a top-level custom object passed by non-const reference.',
  },
  {
    id: 'cpp_vector_of_items_total',
    title: 'Vector of Items Total',
    entryStyle: 'top_level_types',
    methodName: 'totalWeight',
    source: String.raw`#include <vector>
#include <string>

struct Item {
    std::string name = "";
    int weight = 0;
};

class Solution {
public:
    int totalWeight(const std::vector<Item>& items) {
        int total = 0;
        for (const Item& item : items) total += item.weight;
        return total;
    }
};
`,
    input: { items: [{ name: 'a', weight: 2 }, { name: 'b', weight: 5 }, { name: 'c', weight: 1 }] },
    expectedReturn: 8,
    expectedMutations: {},
    coverage: ['top_level_struct', 'custom_objects_inside_vector', 'vector', 'const_reference'],
    notes: 'Stresses hydration of a vector containing custom objects.',
  },
  {
    id: 'cpp_unordered_map_objects_extract',
    title: 'Unordered Map Object Extract',
    entryStyle: 'top_level_types',
    methodName: 'extractCounts',
    source: String.raw`#include <string>
#include <vector>
#include <unordered_map>
#include <map>

struct Counter {
    int count = 0;
};

class Solution {
public:
    std::vector<int> extractCounts(const std::unordered_map<std::string, Counter>& data) {
        std::map<std::string, int> ordered;
        for (const auto& entry : data) ordered[entry.first] = entry.second.count;
        std::vector<int> out;
        for (const auto& entry : ordered) out.push_back(entry.second);
        return out;
    }
};
`,
    input: { data: { z: { count: 9 }, a: { count: 1 }, m: { count: 5 } } },
    expectedReturn: [1, 5, 9],
    expectedMutations: {},
    coverage: ['unordered_map', 'std_map', 'custom_objects_inside_unordered_map', 'lexicographic_ordering'],
    notes: 'Stresses unordered_map hydration while producing deterministic lexicographic output.',
  },
  {
    id: 'cpp_static_scale_numbers',
    title: 'Static Scale Numbers',
    entryStyle: 'solution_static_method',
    methodName: 'scale',
    source: String.raw`#include <vector>

class Solution {
public:
    static std::vector<int> scale(const std::vector<int>& nums, int factor) {
        std::vector<int> out;
        for (int x : nums) out.push_back(x * factor);
        return out;
    }
};
`,
    input: { nums: [2, -1, 0, 4], factor: 3 },
    expectedReturn: [6, -3, 0, 12],
    expectedMutations: {},
    coverage: ['solution_static_method', 'vector', 'multiple_arguments', 'const_reference'],
    notes: 'Stresses discovery and invocation of a static Solution method.',
  },
  {
    id: 'cpp_helper_methods_clamp',
    title: 'Helper Clamp Values',
    entryStyle: 'helper_methods',
    methodName: 'clampAll',
    source: String.raw`#include <vector>

class Solution {
    int clampOne(int x, int lo, int hi) {
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
    }

public:
    std::vector<int> clampAll(const std::vector<int>& nums, int lo, int hi) {
        std::vector<int> out;
        for (int x : nums) out.push_back(clampOne(x, lo, hi));
        return out;
    }
};
`,
    input: { nums: [-5, 0, 7, 20], lo: 1, hi: 10 },
    expectedReturn: [1, 1, 7, 10],
    expectedMutations: {},
    coverage: ['helper_methods', 'private_helper', 'vector', 'multiple_arguments'],
    notes: 'Stresses calling only the public entry method while private helpers exist.',
  },
  {
    id: 'cpp_private_state_counter',
    title: 'Private State Counter',
    entryStyle: 'private_state',
    methodName: 'addAll',
    source: String.raw`#include <vector>

class Solution {
    int running = 100;

public:
    int addAll(const std::vector<int>& nums) {
        for (int x : nums) running += x;
        return running;
    }
};
`,
    input: { nums: [1, 2, 3] },
    expectedReturn: 106,
    expectedMutations: {},
    coverage: ['private_fields', 'vector', 'const_reference'],
    notes: 'Stresses construction of a Solution instance with initialized private state.',
  },
  {
    id: 'cpp_overloaded_helpers_pick',
    title: 'Overloaded Helper Pick',
    entryStyle: 'helper_methods',
    methodName: 'describe',
    source: String.raw`#include <string>
#include <vector>

class Solution {
    std::string label(int x) {
        return "int:" + std::to_string(x);
    }

    std::string label(const std::string& s) {
        return "str:" + s;
    }

public:
    std::vector<std::string> describe(int n, const std::string& word) {
        return {label(n), label(word)};
    }
};
`,
    input: { n: 7, word: 'cat' },
    expectedReturn: ['int:7', 'str:cat'],
    expectedMutations: {},
    coverage: ['overloaded_helper_methods', 'string', 'vector', 'multiple_arguments'],
    notes: 'Stresses tracing and compilation when overloaded helper methods are present.',
  },
  {
    id: 'cpp_using_alias_map_sum',
    title: 'Using Alias Map Sum',
    entryStyle: 'solution_instance_method',
    methodName: 'sumScores',
    source: String.raw`#include <map>
#include <string>

class Solution {
public:
    using Scores = std::map<std::string, int>;

    int sumScores(const Scores& scores) {
        int total = 0;
        for (const auto& entry : scores) total += entry.second;
        return total;
    }
};
`,
    input: { scores: { bob: 4, ann: 3, zoe: 8 } },
    expectedReturn: 15,
    expectedMutations: {},
    coverage: ['using_aliases', 'std_map', 'const_reference', 'string_keys'],
    notes: 'Stresses method parameter hydration through a using alias for std::map.',
  },
  {
    id: 'cpp_mutate_vector_reference',
    title: 'Mutate Vector Reference',
    entryStyle: 'solution_instance_method',
    methodName: 'bumpEach',
    source: String.raw`#include <vector>

class Solution {
public:
    int bumpEach(std::vector<int>& nums, int delta) {
        int total = 0;
        for (int& x : nums) {
            x += delta;
            total += x;
        }
        return total;
    }
};
`,
    input: { nums: [1, 2, 3], delta: 10 },
    expectedReturn: 36,
    expectedMutations: { nums: [11, 12, 13] },
    coverage: ['vector', 'mutable_reference', 'multiple_arguments', 'tracing_loop_mutation'],
    notes: 'Stresses mutation tracking for a vector passed by non-const reference inside a loop.',
  },
  {
    id: 'cpp_empty_containers_echo',
    title: 'Empty Containers Echo',
    entryStyle: 'solution_instance_method',
    methodName: 'sizes',
    source: String.raw`#include <vector>
#include <unordered_map>
#include <string>

class Solution {
public:
    std::vector<int> sizes(const std::vector<int>& nums, const std::unordered_map<std::string, int>& counts) {
        return {static_cast<int>(nums.size()), static_cast<int>(counts.size())};
    }
};
`,
    input: { nums: [], counts: {} },
    expectedReturn: [0, 0],
    expectedMutations: {},
    coverage: ['empty_containers', 'vector', 'unordered_map', 'multiple_arguments'],
    notes: 'Stresses correct handling of empty vector and empty unordered_map inputs.',
  },
  {
    id: 'cpp_default_fields_card',
    title: 'Default Fields Card',
    entryStyle: 'top_level_types',
    methodName: 'scoreCard',
    source: String.raw`#include <string>

struct Card {
    std::string name = "unknown";
    int points = 0;
    bool active = true;
};

class Solution {
public:
    int scoreCard(const Card& card) {
        return card.active ? card.points : -card.points;
    }
};
`,
    input: { card: { points: 6 } },
    expectedReturn: 6,
    expectedMutations: {},
    coverage: ['top_level_struct', 'missing_default_fields', 'custom_object_parameter', 'const_reference'],
    notes: 'Stresses safe default field initialization when optional-ish JSON fields are omitted.',
  },
  {
    id: 'cpp_top_and_nested_same_name',
    title: 'Top and Nested Same Name',
    entryStyle: 'nested_types',
    methodName: 'useNested',
    source: String.raw`#include <string>

struct Node {
    int value = 1000;
};

class Solution {
public:
    struct Node {
        int value = 0;
    };

    int useNested(const Node& node) {
        return node.value + 1;
    }
};
`,
    input: { node: { value: 41 } },
    expectedReturn: 42,
    expectedMutations: {},
    coverage: ['similarly_named_nested_and_top_level_types', 'nested_struct', 'top_level_struct', 'const_reference'],
    notes: 'Stresses type resolution when a top-level type and nested Solution type share the same name.',
  },
  {
    id: 'cpp_return_vector_records_loop',
    title: 'Return Vector Records Loop',
    entryStyle: 'nested_types',
    methodName: 'makeRecords',
    source: String.raw`#include <vector>
#include <string>

class Solution {
public:
    struct Record {
        std::string key = "";
        int value = 0;
    };

    std::vector<Record> makeRecords(const std::vector<int>& nums) {
        std::vector<Record> out;
        for (int i = 0; i < static_cast<int>(nums.size()); ++i) {
            Record r;
            r.key = "i" + std::to_string(i);
            r.value = nums[i];
            out.push_back(r);
        }
        return out;
    }
};
`,
    input: { nums: [5, 8, 13] },
    expectedReturn: [{ key: 'i0', value: 5 }, { key: 'i1', value: 8 }, { key: 'i2', value: 13 }],
    expectedMutations: {},
    coverage: ['nested_struct', 'custom_objects_inside_vector', 'custom_object_return', 'tracing_loop_object_creation'],
    notes: 'Stresses creation, copying, and return serialization of custom objects inside a loop.',
  },
  {
    id: 'cpp_mutate_vector_objects',
    title: 'Mutate Vector Objects',
    entryStyle: 'top_level_types',
    methodName: 'activateAll',
    source: String.raw`#include <vector>
#include <string>

struct User {
    std::string name = "";
    int active = 0;
};

class Solution {
public:
    int activateAll(std::vector<User>& users) {
        int changed = 0;
        for (User& user : users) {
            if (user.active == 0) {
                user.active = 1;
                changed += 1;
            }
        }
        return changed;
    }
};
`,
    input: { users: [{ name: 'ann', active: 0 }, { name: 'bob', active: 1 }, { name: 'cat', active: 0 }] },
    expectedReturn: 2,
    expectedMutations: { users: [{ name: 'ann', active: 1 }, { name: 'bob', active: 1 }, { name: 'cat', active: 1 }] },
    coverage: ['custom_objects_inside_vector', 'mutable_reference', 'tracing_loop_mutation', 'top_level_struct'],
    notes: 'Stresses post-call mutation serialization for a vector of custom objects.',
  },
  {
    id: 'cpp_mutate_unordered_map_objects',
    title: 'Mutate Unordered Map Objects',
    entryStyle: 'top_level_types',
    methodName: 'addBonus',
    source: String.raw`#include <unordered_map>
#include <string>

struct Account {
    int balance = 0;
};

class Solution {
public:
    int addBonus(std::unordered_map<std::string, Account>& accounts, int bonus) {
        int total = 0;
        for (auto& entry : accounts) {
            entry.second.balance += bonus;
            total += entry.second.balance;
        }
        return total;
    }
};
`,
    input: { accounts: { a: { balance: 1 }, b: { balance: 10 } }, bonus: 5 },
    expectedReturn: 21,
    expectedMutations: { accounts: { a: { balance: 6 }, b: { balance: 15 } } },
    coverage: ['unordered_map', 'custom_objects_inside_unordered_map', 'mutable_reference', 'tracing_loop_mutation'],
    notes: 'Stresses mutation tracking for custom objects stored inside an unordered_map.',
  },
  {
    id: 'cpp_map_lexicographic_keys',
    title: 'Map Lexicographic Keys',
    entryStyle: 'solution_instance_method',
    methodName: 'keysInOrder',
    source: String.raw`#include <map>
#include <string>
#include <vector>

class Solution {
public:
    std::vector<std::string> keysInOrder(const std::map<std::string, int>& data) {
        std::vector<std::string> keys;
        for (const auto& entry : data) keys.push_back(entry.first);
        return keys;
    }
};
`,
    input: { data: { beta: 2, alpha: 1, gamma: 3 } },
    expectedReturn: ['alpha', 'beta', 'gamma'],
    expectedMutations: {},
    coverage: ['std_map', 'lexicographic_ordering', 'vector', 'string_keys'],
    notes: 'Stresses deterministic lexicographic ordering from std::map iteration.',
  },
  {
    id: 'cpp_copy_object_inside_loop',
    title: 'Copy Object Inside Loop',
    entryStyle: 'nested_types',
    methodName: 'copyAndShift',
    source: String.raw`#include <vector>

class Solution {
public:
    struct Point {
        int x = 0;
        int y = 0;
    };

    std::vector<Point> copyAndShift(const std::vector<Point>& points, int dx) {
        std::vector<Point> out;
        for (const Point& p : points) {
            Point q = p;
            q.x += dx;
            out.push_back(q);
        }
        return out;
    }
};
`,
    input: { points: [{ x: 1, y: 2 }, { x: 4, y: 8 }], dx: 10 },
    expectedReturn: [{ x: 11, y: 2 }, { x: 14, y: 8 }],
    expectedMutations: {},
    coverage: ['nested_struct', 'custom_objects_inside_vector', 'object_copy', 'tracing_loop_object_creation'],
    notes: 'Stresses tracing and serialization when custom objects are copied and modified in a loop.',
  },
  {
    id: 'cpp_private_alias_state',
    title: 'Private Alias State',
    entryStyle: 'private_state',
    methodName: 'remember',
    source: String.raw`#include <string>
#include <unordered_map>

class Solution {
    using Table = std::unordered_map<std::string, int>;
    Table seen;

public:
    int remember(const std::string& key, int value) {
        seen[key] = value;
        return seen[key];
    }
};
`,
    input: { key: 'id', value: 12 },
    expectedReturn: 12,
    expectedMutations: {},
    coverage: ['private_fields', 'using_aliases', 'unordered_map', 'multiple_arguments'],
    notes: 'Stresses private state using an alias to an unordered_map.',
  },
  {
    id: 'cpp_static_nested_return',
    title: 'Static Nested Return',
    entryStyle: 'solution_static_method',
    methodName: 'makeFlag',
    source: String.raw`#include <string>

class Solution {
public:
    struct Flag {
        std::string name = "";
        bool ok = false;
    };

    static Flag makeFlag(const std::string& name, bool ok) {
        Flag f;
        f.name = name;
        f.ok = ok;
        return f;
    }
};
`,
    input: { name: 'ready', ok: true },
    expectedReturn: { name: 'ready', ok: true },
    expectedMutations: {},
    coverage: ['solution_static_method', 'nested_struct', 'custom_object_return', 'multiple_arguments'],
    notes: 'Stresses static method discovery with a nested custom object return type.',
  },
  {
    id: 'cpp_nested_class_getter',
    title: 'Nested Class Getter',
    entryStyle: 'nested_types',
    methodName: 'read',
    source: String.raw`#include <string>

class Solution {
public:
    class Cell {
    public:
        int row = 0;
        int col = 0;
    };

    std::string read(const Cell& cell) {
        return std::to_string(cell.row) + "," + std::to_string(cell.col);
    }
};
`,
    input: { cell: { row: 2, col: 9 } },
    expectedReturn: '2,9',
    expectedMutations: {},
    coverage: ['nested_class', 'custom_object_parameter', 'const_reference', 'string_return'],
    notes: 'Stresses hydration of a nested class rather than a nested struct.',
  },
  {
    id: 'cpp_return_unordered_map_copy',
    title: 'Return Unordered Map Copy',
    entryStyle: 'solution_instance_method',
    methodName: 'copyPositive',
    source: String.raw`#include <string>
#include <unordered_map>

class Solution {
public:
    std::unordered_map<std::string, int> copyPositive(const std::unordered_map<std::string, int>& data) {
        std::unordered_map<std::string, int> out;
        for (const auto& entry : data) {
            if (entry.second > 0) out[entry.first] = entry.second;
        }
        return out;
    }
};
`,
    input: { data: { keep: 3, zero: 0, drop: -2 } },
    expectedReturn: { keep: 3 },
    expectedMutations: {},
    coverage: ['unordered_map', 'const_reference', 'filter_values', 'return_container'],
    notes: 'Stresses serialization of an unordered_map return value where key order should not matter.',
  },
  {
    id: 'cpp_multiple_custom_args',
    title: 'Multiple Custom Args',
    entryStyle: 'top_level_types',
    methodName: 'merge',
    source: String.raw`#include <string>

struct Left {
    int x = 0;
};

struct Right {
    int y = 0;
};

struct PairOut {
    int sum = 0;
    std::string label = "";
};

class Solution {
public:
    PairOut merge(const Left& left, const Right& right, const std::string& label) {
        PairOut out;
        out.sum = left.x + right.y;
        out.label = label;
        return out;
    }
};
`,
    input: { left: { x: 8 }, right: { y: 13 }, label: 'ok' },
    expectedReturn: { sum: 21, label: 'ok' },
    expectedMutations: {},
    coverage: ['top_level_struct', 'multiple_arguments', 'custom_object_parameter', 'custom_object_return'],
    notes: 'Stresses hydration of multiple distinct custom object arguments and return serialization.',
  },
  {
    id: 'cpp_void_mutation_return_null',
    title: 'Void Mutation Return Null',
    entryStyle: 'solution_instance_method',
    methodName: 'clearNegatives',
    source: String.raw`#include <vector>

class Solution {
public:
    void clearNegatives(std::vector<int>& nums) {
        for (int& x : nums) {
            if (x < 0) x = 0;
        }
    }
};
`,
    input: { nums: [-3, 4, -1, 0] },
    expectedReturn: null,
    expectedHarnessOutput: [0, 4, 0, 0],
    expectedMutations: { nums: [0, 4, 0, 0] },
    coverage: ['void_return', 'mutable_reference', 'vector', 'tracing_loop_mutation'],
    notes: 'Stresses handling of void methods while still reporting reference mutations.',
  },
  {
    id: 'cpp17_using_alias_records',
    title: 'Using Alias Records',
    entryStyle: 'nested_types',
    methodName: 'names',
    source: String.raw`#include <string>
#include <vector>

class Solution {
public:
    struct Record {
        std::string name = "";
        int score = 0;
    };

    using Records = std::vector<Record>;

    std::vector<std::string> names(const Records& records) {
        std::vector<std::string> out;
        for (const Record& r : records) out.push_back(r.name);
        return out;
    }
};
`,
    input: { records: [{ name: 'a', score: 1 }, { name: 'b', score: 2 }] },
    expectedReturn: ['a', 'b'],
    expectedMutations: {},
    coverage: ['using_aliases', 'nested_struct', 'custom_objects_inside_vector', 'vector'],
    notes: 'Stresses using aliases that refer to vectors of nested custom objects.',
  },
  {
    id: 'cpp17_nested_object_fields',
    title: 'Nested Object Fields',
    entryStyle: 'top_level_types',
    methodName: 'span',
    source: String.raw`#include <string>

struct Point {
    int x = 0;
    int y = 0;
};

struct Segment {
    Point start;
    Point end;
};

class Solution {
public:
    int span(const Segment& segment) {
        return (segment.end.x - segment.start.x) + (segment.end.y - segment.start.y);
    }
};
`,
    input: { segment: { start: { x: 1, y: 2 }, end: { x: 5, y: 7 } } },
    expectedReturn: 9,
    expectedMutations: {},
    coverage: ['top_level_struct', 'nested_custom_object_field', 'custom_object_parameter', 'const_reference'],
    notes: 'Stresses hydration of custom objects nested as fields inside other custom objects.',
  },
  {
    id: 'cpp17_static_void_mutation',
    title: 'Static Void Mutation',
    entryStyle: 'solution_static_method',
    methodName: 'zeroOut',
    source: String.raw`#include <vector>

class Solution {
public:
    static void zeroOut(std::vector<int>& nums) {
        for (int& x : nums) x = 0;
    }
};
`,
    input: { nums: [4, 5, 6] },
    expectedReturn: null,
    expectedHarnessOutput: [0, 0, 0],
    expectedMutations: { nums: [0, 0, 0] },
    coverage: ['solution_static_method', 'void_return', 'mutable_reference', 'tracing_loop_mutation'],
    notes: 'Stresses static void method handling with reference mutations.',
  },
  {
    id: 'cpp17_const_nested_map_object',
    title: 'Const Nested Map Object',
    entryStyle: 'top_level_types',
    methodName: 'lookup',
    source: String.raw`#include <string>
#include <unordered_map>

struct Entry {
    std::string code = "";
    int value = 0;
};

class Solution {
public:
    int lookup(const std::unordered_map<std::string, Entry>& table, const std::string& key) {
        auto it = table.find(key);
        if (it == table.end()) return -1;
        return it->second.value;
    }
};
`,
    input: { table: { one: { code: 'a', value: 1 }, two: { code: 'b', value: 2 } }, key: 'two' },
    expectedReturn: 2,
    expectedMutations: {},
    coverage: ['unordered_map', 'custom_objects_inside_unordered_map', 'const_reference', 'multiple_arguments'],
    notes: 'Stresses lookup in unordered_map<string, custom object> passed by const reference.',
  },
  {
    id: 'cpp17_return_object_from_map',
    title: 'Return Object From Map',
    entryStyle: 'top_level_types',
    methodName: 'getOrDefault',
    source: String.raw`#include <string>
#include <map>

struct Thing {
    std::string name = "missing";
    int count = 0;
};

class Solution {
public:
    Thing getOrDefault(const std::map<std::string, Thing>& things, const std::string& key) {
        auto it = things.find(key);
        if (it == things.end()) return Thing{};
        return it->second;
    }
};
`,
    input: { things: { a: { name: 'apple', count: 5 } }, key: 'b' },
    expectedReturn: { name: 'missing', count: 0 },
    expectedMutations: {},
    coverage: ['std_map', 'top_level_struct', 'custom_object_return', 'default_fields'],
    notes: 'Stresses default construction of a custom return object after map lookup miss.',
  },
  {
    id: 'cpp17_object_with_map_field',
    title: 'Object With Map Field',
    entryStyle: 'nested_types',
    methodName: 'orderedValues',
    source: String.raw`#include <map>
#include <string>
#include <vector>

class Solution {
public:
    struct NamedMap {
        std::string name = "";
        std::map<std::string, int> values;
    };

    std::vector<int> orderedValues(const NamedMap& data) {
        std::vector<int> out;
        for (const auto& entry : data.values) out.push_back(entry.second);
        return out;
    }
};
`,
    input: { data: { name: 'test', values: { b: 20, a: 10 } } },
    expectedReturn: [10, 20],
    expectedMutations: {},
    coverage: ['nested_struct', 'std_map', 'map_field', 'lexicographic_ordering'],
    notes: 'Stresses a custom object containing a std::map field.',
  },
  {
    id: 'cpp17_nested_alias_unordered',
    title: 'Nested Alias Unordered',
    entryStyle: 'nested_types',
    methodName: 'total',
    source: String.raw`#include <string>
#include <unordered_map>

class Solution {
public:
    struct Metric {
        int amount = 0;
    };

    using Metrics = std::unordered_map<std::string, Metric>;

    int total(const Metrics& metrics) {
        int sum = 0;
        for (const auto& entry : metrics) sum += entry.second.amount;
        return sum;
    }
};
`,
    input: { metrics: { a: { amount: 3 }, b: { amount: 4 } } },
    expectedReturn: 7,
    expectedMutations: {},
    coverage: ['using_aliases', 'unordered_map', 'custom_objects_inside_unordered_map', 'nested_struct'],
    notes: 'Stresses using alias to unordered_map<string, nested custom object>.',
  },
  {
    id: 'cpp17_mutate_object_map_field',
    title: 'Mutate Object Map Field',
    entryStyle: 'top_level_types',
    methodName: 'setValue',
    source: String.raw`#include <map>
#include <string>

struct Store {
    std::map<std::string, int> values;
};

class Solution {
public:
    int setValue(Store& store, const std::string& key, int value) {
        store.values[key] = value;
        return static_cast<int>(store.values.size());
    }
};
`,
    input: { store: { values: { a: 1 } }, key: 'b', value: 2 },
    expectedReturn: 2,
    expectedMutations: { store: { values: { a: 1, b: 2 } } },
    coverage: ['top_level_struct', 'map_field', 'mutable_reference', 'multiple_arguments'],
    notes: 'Stresses mutation tracking for a std::map field inside a custom object.',
  },
  {
    id: 'cpp17_two_mutable_references',
    title: 'Two Mutable References',
    entryStyle: 'solution_instance_method',
    methodName: 'moveLast',
    source: String.raw`#include <vector>

class Solution {
public:
    int moveLast(std::vector<int>& from, std::vector<int>& to) {
        if (!from.empty()) {
            int value = from.back();
            from.pop_back();
            to.push_back(value);
        }
        return static_cast<int>(to.size());
    }
};
`,
    input: { from: [1, 2, 3], to: [9] },
    expectedReturn: 2,
    expectedMutations: { from: [1, 2], to: [9, 3] },
    coverage: ['mutable_reference', 'multiple_mutable_references', 'vector', 'multiple_arguments'],
    notes: 'Stresses reporting mutations for more than one reference argument.',
  },
  {
    id: 'cpp17_string_mutation_reference',
    title: 'String Mutation Reference',
    entryStyle: 'solution_instance_method',
    methodName: 'appendSuffix',
    source: String.raw`#include <string>

class Solution {
public:
    int appendSuffix(std::string& text, const std::string& suffix) {
        text += suffix;
        return static_cast<int>(text.size());
    }
};
`,
    input: { text: 'core', suffix: '-x' },
    expectedReturn: 6,
    expectedMutations: { text: 'core-x' },
    coverage: ['string', 'mutable_reference', 'const_reference', 'multiple_arguments'],
    notes: 'Stresses mutation tracking for std::string passed by non-const reference.',
  },
  {
    id: 'cpp17_top_level_class_public_fields',
    title: 'Top-Level Class Public Fields',
    entryStyle: 'top_level_types',
    methodName: 'sum',
    source: String.raw`#include <string>

class PairBox {
public:
    int left = 0;
    int right = 0;
};

class Solution {
public:
    int sum(const PairBox& box) {
        return box.left + box.right;
    }
};
`,
    input: { box: { left: 6, right: 7 } },
    expectedReturn: 13,
    expectedMutations: {},
    coverage: ['top_level_class', 'custom_object_parameter', 'const_reference'],
    notes: 'Stresses hydration of a top-level class with public fields instead of a struct.',
  },
  {
    id: 'cpp17_private_state_custom_object',
    title: 'Private State Custom Object',
    entryStyle: 'private_state',
    methodName: 'withOffset',
    source: String.raw`#include <string>

class Solution {
    struct Offset {
        int dx = 2;
        int dy = 3;
    };

    Offset offset;

public:
    struct Point {
        int x = 0;
        int y = 0;
    };

    Point withOffset(const Point& point) {
        Point out = point;
        out.x += offset.dx;
        out.y += offset.dy;
        return out;
    }
};
`,
    input: { point: { x: 10, y: 20 } },
    expectedReturn: { x: 12, y: 23 },
    expectedMutations: {},
    coverage: ['private_fields', 'private_nested_struct', 'nested_struct', 'custom_object_return'],
    notes: 'Stresses private custom object state used to construct a public nested return object.',
  },
  {
    id: 'cpp17_return_empty_custom_vector',
    title: 'Return Empty Custom Vector',
    entryStyle: 'top_level_types',
    methodName: 'none',
    source: String.raw`#include <string>
#include <vector>

struct Event {
    std::string name = "";
    int time = 0;
};

class Solution {
public:
    std::vector<Event> none() {
        return {};
    }
};
`,
    input: {},
    expectedReturn: [],
    expectedMutations: {},
    coverage: ['top_level_struct', 'custom_objects_inside_vector', 'empty_containers', 'zero_arguments'],
    notes: 'Stresses serialization of an empty vector with a custom object element type.',
  },
];
