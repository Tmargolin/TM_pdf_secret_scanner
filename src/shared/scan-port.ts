// The parts of chrome.runtime.Port that both ends of the scan port use
// (DESIGN.md §2 flows 3 and 5). A real chrome.runtime.Port fits this shape;
// tests pass small fakes.

export interface PortEvent<L> {
  addListener(listener: L): void;
}

export interface ScanPort {
  readonly name: string;
  /** Set by Chrome on the receiving end: who opened the port. */
  readonly sender?: chrome.runtime.MessageSender | undefined;
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: PortEvent<(message: unknown) => void>;
  readonly onDisconnect: PortEvent<() => void>;
}
