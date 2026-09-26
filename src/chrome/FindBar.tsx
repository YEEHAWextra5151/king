import { useEffect, useRef } from "react";
import { findController, useFind } from "../app/findController";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon } from "./icons";

export function FindBar() {
  const { open, query, total, current, focusSeq } = useFind();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open, focusSeq]);

  if (!open) return null;
  const status = !query ? "" : total === 0 ? "Not found" : `${current + 1} of ${total}${total >= 5000 ? "+" : ""}`;

  return (
    <div className="findbar" role="search">
      <label className="search-field">
        <SearchIcon />
        <input
          ref={input}
          type="search"
          value={query}
          placeholder="Find in document"
          aria-label="Find in document"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => findController.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              findController.step(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              findController.close();
            }
          }}
        />
      </label>
      <span className={`find-count${query && total === 0 ? " no-match" : ""}`} aria-live="polite">
        {status}
      </span>
      <div className="segmented" role="group" aria-label="Matches">
        <button type="button" aria-label="Previous match" title="Previous (⇧⌘G)" disabled={total === 0} onClick={() => findController.step(-1)}>
          <ChevronLeftIcon />
        </button>
        <button type="button" aria-label="Next match" title="Next (⌘G)" disabled={total === 0} onClick={() => findController.step(1)}>
          <ChevronRightIcon />
        </button>
      </div>
      <span className="spacer" />
      <button type="button" className="push-button" onClick={() => findController.close()}>
        Done
      </button>
    </div>
  );
}
