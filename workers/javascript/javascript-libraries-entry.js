import lodash from 'lodash';
import * as binarySearchTree from '@datastructures-js/binary-search-tree';
import * as deque from '@datastructures-js/deque';
import * as graph from '@datastructures-js/graph';
import * as heap from '@datastructures-js/heap';
import * as linkedList from '@datastructures-js/linked-list';
import * as priorityQueue from '@datastructures-js/priority-queue';
import * as queue from '@datastructures-js/queue';
import * as enhancedSet from '@datastructures-js/set';
import * as stack from '@datastructures-js/stack';
import * as trie from '@datastructures-js/trie';

const modules = {
  lodash,
  'lodash.js': lodash,
  '@datastructures-js/binary-search-tree': binarySearchTree,
  '@datastructures-js/deque': deque,
  '@datastructures-js/graph': graph,
  '@datastructures-js/heap': heap,
  '@datastructures-js/linked-list': linkedList,
  '@datastructures-js/priority-queue': priorityQueue,
  '@datastructures-js/queue': queue,
  '@datastructures-js/set': enhancedSet,
  '@datastructures-js/stack': stack,
  '@datastructures-js/trie': trie,
};

const scope = typeof globalThis !== 'undefined' ? globalThis : self;
const previousRequire = typeof scope.require === 'function' ? scope.require : null;

function tracecodeJavaScriptLibrariesRequire(specifier) {
  if (Object.prototype.hasOwnProperty.call(modules, specifier)) {
    return modules[specifier];
  }
  if (previousRequire && previousRequire !== tracecodeJavaScriptLibrariesRequire) {
    return previousRequire(specifier);
  }
  throw new Error(`Cannot find module '${specifier}'`);
}

Object.defineProperty(scope, '__TRACECODE_JAVASCRIPT_LIBRARIES__', {
  value: Object.freeze({ ...modules }),
  configurable: true,
});
Object.defineProperty(scope, 'require', {
  value: tracecodeJavaScriptLibrariesRequire,
  configurable: true,
  writable: true,
});

scope._ = lodash;
scope.lodash = lodash;
scope.module = scope.module || { exports: {} };
scope.exports = scope.exports || scope.module.exports || {};

Object.assign(scope, {
  Deque: deque.Deque,
  DoublyLinkedList: linkedList.DoublyLinkedList,
  DoublyLinkedListNode: linkedList.DoublyLinkedListNode,
  EnhancedSet: enhancedSet.EnhancedSet,
  Heap: heap.Heap,
  LinkedList: linkedList.LinkedList,
  LinkedListNode: linkedList.LinkedListNode,
  MaxHeap: heap.MaxHeap,
  MaxPriorityQueue: priorityQueue.MaxPriorityQueue,
  MinHeap: heap.MinHeap,
  MinPriorityQueue: priorityQueue.MinPriorityQueue,
  PriorityQueue: priorityQueue.PriorityQueue,
  Queue: queue.Queue,
  Stack: stack.Stack,
});
