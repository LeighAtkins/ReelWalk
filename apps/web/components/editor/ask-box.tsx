"use client";

import { useRef, useState } from "react";
import { AskIcon, SendIcon } from "../icons";

/**
 * Ask, always there (ADR 0064): one line under the picture, "Change
 * anything…". What is selected scopes it ("Change this title…"); sending
 * opens the Ask sheet with the words and runs them, so the answer, any
 * questions and Undo are where they always were. The button at its start
 * opens the sheet empty: ready-made briefs and Ask Opus (the director).
 */
export function AskBox({ placeholder, disabled, onSend, onOpen }: { placeholder: string; disabled?: boolean; onSend(request: string): void; onOpen(): void }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const ready = text.trim().length >= 3;
  return (
    <form
      className="ask-box"
      role="search"
      aria-label="Change anything"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || disabled) return;
        // The keyboard drops so the answer and the reel are in view.
        input.current?.blur();
        onSend(text.trim());
        setText("");
      }}
    >
      <button type="button" className="ask-box-open" aria-label="Ways to ask" onClick={onOpen} disabled={disabled} data-testid="ask-box-open">
        <AskIcon size={20} />
      </button>
      <input
        ref={input}
        className="ask-box-input"
        value={text}
        maxLength={600}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        enterKeyHint="send"
        onChange={(event) => setText(event.target.value)}
        data-testid="ask-box"
      />
      <button type="submit" className="ask-box-send" aria-label="Send" disabled={disabled || !ready} data-testid="ask-box-send">
        <SendIcon size={20} />
      </button>
    </form>
  );
}
