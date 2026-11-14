import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { Message } from '../../types';

export interface MessageFeedHandle { scrollToMessage: (id: string) => void; }
interface MessageFeedProps {
  conversationId: string;
  messages: Message[];
  highlightedMessageId?: string | null;
  emptyContent: ReactNode;
  renderMessage: (message: Message) => ReactNode;
}

export const MessageFeed = forwardRef<MessageFeedHandle, MessageFeedProps>(function MessageFeed(
  { conversationId, messages, highlightedMessageId, emptyContent, renderMessage }, ref
) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useRef<VirtuosoHandle>(null);
  const atBottom = useRef(true);
  const previousConversation = useRef(conversationId);
  const virtualized = messages.length >= 500;

  useImperativeHandle(ref, () => ({
    scrollToMessage(id) {
      const index = messages.findIndex(item => item.id === id);
      if (index < 0) return;
      if (virtualized) virtualizer.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
      else {
        const target = scroller.current?.querySelector<HTMLElement>(`[data-message-index="${index}"]`);
        const region = scroller.current;
        if (target && region) {
          const regionBox = region.getBoundingClientRect();
          const targetBox = target.getBoundingClientRect();
          region.scrollTo({
            top: region.scrollTop + targetBox.top - regionBox.top - (region.clientHeight - targetBox.height) / 2,
            behavior: 'smooth',
          });
        }
      }
      atBottom.current = false;
    },
  }), [messages, virtualized]);

  const last = messages[messages.length - 1];
  useLayoutEffect(() => {
    if (virtualized) return;
    const el = scroller.current;
    if (!el) return;
    const changed = previousConversation.current !== conversationId;
    if (changed) {
      previousConversation.current = conversationId;
      atBottom.current = true;
    }
    if (messages.length === 0) { el.scrollTop = 0; return; }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [conversationId, messages.length, last?.content, last?.thinking?.text, virtualized]);

  useEffect(() => { atBottom.current = true; }, [conversationId]);

  const renderRow = (message: Message, index: number) => (
    <div
      key={message.id}
      id={`message-${message.id}`}
      data-message-index={index}
      className={highlightedMessageId === message.id ? 'aira-v3-message-highlight' : undefined}
    >
      {renderMessage(message)}
    </div>
  );

  if (!messages.length) {
    return <div className="aira-v3-chat-scroll aira-v3-chat-empty" data-testid="chat-scroll-region">{emptyContent}</div>;
  }
  if (virtualized) {
    return (
      <Virtuoso
        key={conversationId}
        ref={virtualizer}
        className="aira-v3-chat-scroll"
        data-testid="chat-scroll-region"
        data={messages}
        computeItemKey={(_index, message) => message.id}
        initialTopMostItemIndex={Math.max(0, messages.length - 1)}
        atBottomThreshold={96}
        atBottomStateChange={value => { atBottom.current = value; }}
        followOutput={value => value ? 'auto' : false}
        itemContent={(index, message) => renderRow(message, index)}
      />
    );
  }
  return (
    <div
      ref={scroller}
      className="aira-v3-chat-scroll"
      data-testid="chat-scroll-region"
      onScroll={event => {
        const target = event.currentTarget;
        atBottom.current = target.scrollHeight - target.clientHeight - target.scrollTop <= 96;
      }}
    >
      <div className="aira-v3-chat-transcript">{messages.map(renderRow)}</div>
    </div>
  );
});

