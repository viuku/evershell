import { useEffect, useRef, useState } from 'react';
import type { FindResults, SessionManager } from '../../core/session-manager';
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from '../common/Icons';

interface Props {
  manager: SessionManager;
  sessionId: string;
  /** 每按一次打开搜索的快捷键加一，搜索框已经开着时据此重新选中输入框 */
  focusSeq: number;
  onClose(): void;
}

/** 终端右上角的搜索框：边打字边找，回车 / Shift+回车跳到下一处 / 上一处，Esc 关掉 */
export function TerminalSearch({ manager, sessionId, focusSeq, onClose }: Props) {
  const [query, setQuery] = useState(() => manager.selectedText(sessionId));
  const [results, setResults] = useState<FindResults | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => manager.onFindResults(sessionId, setResults), [manager, sessionId]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSeq]);

  useEffect(() => {
    if (!query) setResults(null);
    manager.find(sessionId, query, 'typing');
  }, [manager, sessionId, query]);

  // 关掉或换标签时去掉高亮
  useEffect(() => () => manager.clearFind(sessionId), [manager, sessionId]);

  const step = (dir: 'next' | 'prev') => {
    if (query) manager.find(sessionId, query, dir);
  };

  let count = '';
  if (query && results) {
    if (results.count === 0) count = '无结果';
    else if (results.index > 0) count = `${results.index}/${results.count}`;
    else count = `${results.count} 处`;
  }

  return (
    <div className="term-find" role="search">
      <input
        ref={inputRef}
        className="field term-find__input"
        value={query}
        placeholder="搜索终端内容"
        aria-label="搜索终端内容"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? 'prev' : 'next');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="term-find__count" aria-live="polite">
        {count}
      </span>
      <button type="button" className="cmdbar__tool" aria-label="上一处" title="上一处" disabled={!query} onClick={() => step('prev')}>
        <ChevronUpIcon size={13} />
      </button>
      <button type="button" className="cmdbar__tool" aria-label="下一处" title="下一处" disabled={!query} onClick={() => step('next')}>
        <ChevronDownIcon size={13} />
      </button>
      <button type="button" className="cmdbar__tool" aria-label="关闭搜索" title="关闭" onClick={onClose}>
        <CloseIcon size={9} />
      </button>
    </div>
  );
}
