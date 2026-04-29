def fail():
    raise ValueError("bad input")

def solve(n):
    try:
        fail()
    except ValueError:
        return n
