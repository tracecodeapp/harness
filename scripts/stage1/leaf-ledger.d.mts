export function leafLedger(leaf: string): {
  nonce: string;
  checked(id: string): void;
  done(): void;
};
export interface LeafEvent {
  leaf: string;
  nonce: string;
  pid: number;
  kind: 'start' | 'assertion' | 'done';
  id?: string;
}
export function missingEvidence(leaf: string, expected: string[], events: LeafEvent[]): string[];
