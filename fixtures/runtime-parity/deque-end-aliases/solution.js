function solve(nums) {
  const deck = [];
  deck.unshift(nums[0]);
  deck.push(nums[0]);
  deck.push(nums[1]);
  deck.shift(); // pollFirst
  deck.push(nums[2]);
  deck.shift(); // removeFirst
  deck.pop(); // pollLast
  deck.push(nums[3]);
  deck.pop(); // removeLast
  return deck.length;
}
