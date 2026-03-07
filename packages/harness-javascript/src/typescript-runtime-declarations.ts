export const TYPESCRIPT_RUNTIME_DECLARATIONS = `
declare class ListNode {
  val: any;
  next: ListNode | SerializedListNode | SerializedRef | null;
  prev?: ListNode | SerializedListNode | SerializedRef | null;
  constructor(val?: any, next?: ListNode | null);
}

declare class TreeNode {
  val: any;
  left: TreeNode | SerializedTreeNode | SerializedRef | null;
  right: TreeNode | SerializedTreeNode | SerializedRef | null;
  constructor(val?: any, left?: TreeNode | null, right?: TreeNode | null);
}

type SerializedRef = { __ref__: string };

type SerializedListNode = {
  __id__?: string;
  __type__?: 'ListNode';
  val?: any;
  next?: SerializedListNode | SerializedRef | ListNode | null;
  prev?: SerializedListNode | SerializedRef | ListNode | null;
};

type SerializedTreeNode = {
  __id__?: string;
  __type__?: 'TreeNode';
  val?: any;
  left?: SerializedTreeNode | SerializedRef | TreeNode | null;
  right?: SerializedTreeNode | SerializedRef | TreeNode | null;
};
`;

export function withTypeScriptRuntimeDeclarations(sourceCode: string): string {
  return `${sourceCode}\n\n${TYPESCRIPT_RUNTIME_DECLARATIONS}\n`;
}

