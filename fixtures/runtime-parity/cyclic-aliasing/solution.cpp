int solve(ListNode* head) {
  ListNode* alias = head;
  return alias->next->val;
}
