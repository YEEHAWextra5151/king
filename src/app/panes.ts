/**
 * Imperative handles for mounted tabs, used by menu actions (find, select
 * all, copy, print, heading jumps) that act on the active document.
 */
import type { FindTarget } from "../views/find";

export interface PaneHandle {
  focus(): void;
  /** Fractional 0-based source line at the top of the visible pane. */
  topLine(): number;
  scrollToLine(line: number, flash?: boolean): void;
  selectAll(): void;
  /** The pane find should search (preview, or code in Code view). */
  finder(): FindTarget | null;
  /** Sanitized rendered HTML of the document, if rendered. */
  renderedHtml(): string | null;
  headingJump(direction: 1 | -1): void;
  /** 1-based line for Open in Editor. */
  editorLine(): number;
  /** Prepares the DOM for printing; returns a cleanup function. */
  preparePrint(): () => void;
  /** Re-renders theme-dependent output (Mermaid). */
  retheme(): void;
  /** Text selected in the pane (Use Selection for Find). */
  selectedText(): string;
}

export const panes = new Map<string, PaneHandle>();
