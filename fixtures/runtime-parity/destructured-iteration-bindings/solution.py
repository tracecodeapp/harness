def solve():
    prerequisites = [(1, 0), (2, 1)]
    total = 0
    for course, prereq in prerequisites:
        total += course * 10 + prereq
    return total
