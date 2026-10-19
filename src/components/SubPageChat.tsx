import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { MarkdownDocument } from './MarkdownDocument';
import './SubPageChat.css';

export type SubPageChatMessage = {
  type: string;
  text?: string;
  time?: string;
};

export type SubPageChatHandle = {
  inject: (text: string) => void;
};

type Suggestion = {
  label: string;
  onClick: () => void;
};

type Props = {
  title?: string;
  subtitle?: string;
  messages?: SubPageChatMessage[];
  customRenderers?: Record<string, (msg: SubPageChatMessage, index: number) => ReactNode>;
  suggestions?: Suggestion[];
  placeholder?: string;
  hint?: string;
  isLoading?: boolean;
  disabled?: boolean;
  onSend?: (text: string) => void;
  onStop?: () => void;
};

export const SubPageChat = forwardRef<SubPageChatHandle, Props>(function SubPageChat({
  title = 'Chat Edit',
  subtitle = 'Describe what to change, AI will update steps directly',
  messages = [],
  customRenderers = {},
  suggestions = [],
  placeholder = 'Type a message...',
  hint = 'Enter to send · Shift+Enter for new line',
  isLoading = false,
  disabled = false,
  onSend,
  onStop,
}, ref) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    inject(text) {
      setValue(text);
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
  }));

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(() => {
    const text = value.trim();
    if (!text || isLoading || disabled) return;
    onSend?.(text);
    setValue('');
  }, [value, isLoading, disabled, onSend]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const renderMessage = (msg: SubPageChatMessage, index: number) => {
    if (customRenderers[msg.type]) {
      return customRenderers[msg.type](msg, index);
    }

    if (msg.type === 'thinking') {
      return (
        <div key={index} className="spc-thinking">
          <span className="spc-thinking-dot" />
          <span className="spc-thinking-dot" />
          <span className="spc-thinking-dot" />
        </div>
      );
    }

    return (
      <div key={index} className={`spc-msg spc-msg-${msg.type}`}>
        <div className="spc-msg-bubble">
          {msg.text ? <MarkdownDocument markdown={msg.text} /> : null}
        </div>
        {msg.time ? <div className="spc-msg-time">{msg.time}</div> : null}
      </div>
    );
  };

  return (
    <div className="spc-panel">
      <div className="spc-header">
        <div className="spc-header-title">{title}</div>
        <div className="spc-header-sub">{subtitle}</div>
      </div>

      <div className="spc-messages" ref={messagesRef}>
        {messages.map(renderMessage)}
      </div>

      <div className="spc-input-wrap">
        <div className="spc-input-box">
          {suggestions.length > 0 ? (
            <div className="spc-input-top">
              {suggestions.map((item, index) => (
                <span key={index} className="spc-suggest" onClick={item.onClick}>
                  {item.label}
                </span>
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            className="spc-textarea"
            placeholder={isLoading ? 'AI is thinking...' : placeholder}
            rows={2}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading || disabled}
          />

          <div className="spc-input-footer">
            <span className="spc-hint">{hint}</span>
            <button
              className={`spc-send${isLoading ? ' spc-send-stop' : ''}`}
              type="button"
              onClick={isLoading ? onStop : handleSend}
            >
              {isLoading ? (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <circle cx="9" cy="9" r="8" stroke="#1a1917" strokeWidth="1.5" />
                  <rect x="5.5" y="5.5" width="7" height="7" rx="1" fill="#1a1917" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="13" x2="8" y2="3" />
                  <polyline points="4 7 8 3 12 7" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
