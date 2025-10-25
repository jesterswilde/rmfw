'use strict';

/**
 * Standalone JavaScript version of the WGSL traversal algorithm.
 * Includes self-contained tests. Just run with:
 *    node traverseNodes.js
 *
 * No external packages required.
 */

/**
 * @typedef {Object} Node
 * @property {number} id - identifier for testing and debugging
 * @property {number} childIndex - index of first child, or -1 if none
 * @property {number} siblingIndex - index of next sibling, or -1 if none
 */

/**
 * Performs a post-order depth-first traversal using an explicit stack.
 * @param {Node[]} shapes - array representing the nodes
 * @param {number} rootIndex - index of the root node
 * @param {(node: Node) => void} evaluate - callback to "evaluate" a node
 */
function traverseNodes(shapes, rootIndex, evaluate) {
  if (!Array.isArray(shapes)) throw new Error('shapes must be an array');
  if (rootIndex < 0 || rootIndex >= shapes.length)
    throw new Error('rootIndex out of range');

  const stack = [];
  let stackI = 0;
  stack[stackI] = shapes[rootIndex];
  let isPopping = false;

  while (stackI >= 0) {
    const node = stack[stackI];
    if (node.childIndex === -1) {
      // Leaf node
      evaluate(node);
      if (node.siblingIndex !== -1) {
        stack[stackI] = shapes[node.siblingIndex];
      } else {
        isPopping = true;
        stackI--;
      }
    } else if (!isPopping) {
      // Go down to first child
      stackI++;
      stack[stackI] = shapes[node.childIndex];
    } else {
      // Finished children: evaluate internal node
      evaluate(node);
      if (node.siblingIndex !== -1) {
        stack[stackI] = shapes[node.siblingIndex];
        isPopping = false;
      } else {
        stackI--;
      }
    }
  }
}

/***********************
 * Simple Test Utilities
 ***********************/
function assert(condition, message) {
  if (!condition) throw new Error('Assertion failed: ' + (message || ''));
}
function assertEqual(a, b, message) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr !== bStr) throw new Error(`Assertion failed: ${message}\nExpected ${bStr}\nGot ${aStr}`);
}

/********************
 * Test Suite
 ********************/
function makeNode(id, childIndex = -1, siblingIndex = -1) {
  return { id, childIndex, siblingIndex };
}

function runTraversal(shapes, rootIndex) {
  const visited = [];
  traverseNodes(shapes, rootIndex, (n) => visited.push(n.id));
  return visited;
}

(function test_single_node() {
  const shapes = [makeNode(0, -1, -1)];
  assertEqual(runTraversal(shapes, 0), [0], 'single node');
})();

(function test_linear_children() {
  const shapes = [makeNode(0, 1, -1), makeNode(1, 2, -1), makeNode(2, -1, -1)];
  assertEqual(runTraversal(shapes, 0), [2, 1, 0], 'linear children traversal');
})();

(function test_siblings_only() {
  const shapes = [makeNode(0, -1, 1), makeNode(1, -1, 2), makeNode(2, -1, -1)];
  assertEqual(runTraversal(shapes, 0), [0, 1, 2], 'sibling traversal');
})();

(function test_branching_tree() {
  // Tree encoded in first-child / next-sibling form:
  //        0
  //      / | \
  //     1  3  5
  //     |  |\
  //     2  4 6
  const shapes = [
    makeNode(0, 1, -1),
    makeNode(1, 2, 3),
    makeNode(2, -1, -1),
    makeNode(3, 4, 5),
    makeNode(4, -1, 6),
    makeNode(5, -1, -1),
    makeNode(6, -1, -1),
  ];
  const expected = [2, 1, 4, 6, 3, 5, 0];
  assertEqual(runTraversal(shapes, 0), expected, 'branching traversal');
})();

(function test_post_order_ordering() {
  const shapes = [makeNode(0, 1, -1), makeNode(1, 2, -1), makeNode(2, -1, -1)];
  const visited = runTraversal(shapes, 0);
  const idx2 = visited.indexOf(2);
  const idx1 = visited.indexOf(1);
  const idx0 = visited.indexOf(0);
  assert(idx2 < idx1 && idx1 < idx0, 'post-order traversal order violated');
})();

console.log('✅ All tests passed successfully.');
