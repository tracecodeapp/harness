class Node {
    int val;
    Node prev;
    Node next;

    Node(int val) {
        this.val = val;
    }
}

public class Solution {
    Node head = new Node(0);
    Node tail = new Node(0);

    public int solve(int value) {
        head.next = tail;
        tail.prev = head;
        Node node = new Node(value);
        head.next.prev = node;
        return value;
    }
}
