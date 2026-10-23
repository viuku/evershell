import type { SessionInfo, SessionManager } from '../core/session-manager';
import { bottomPanelOpen, type Scheme } from '../core/settings';
import { useStore } from '../core/store';
import { BottomPanels, type BottomTab } from './panels/BottomPanels';
import { AppearancePanel } from './terminal/AppearancePanel';
import { CommandBar } from './terminal/CommandBar';
import { TerminalSearch } from './terminal/TerminalSearch';
import { TerminalView } from './terminal/TerminalView';

interface Props {
  manager: SessionManager;
  session: SessionInfo;
  scheme: Scheme;
  connectedCount: number;
  lookOpen: boolean;
  onToggleLook(): void;
  bottomTab: BottomTab;
  onBottomTab(tab: BottomTab): void;
  /** 搜索框开着时是第几次打开（快捷键每按一次加一），关着为 null */
  findSeq: number | null;
  onToggleFind(): void;
  onReconnect(): void;
  onEditConnection: (() => void) | null;
}

/** 一个会话标签的内容：终端 + 搜索框 + 命令栏（含外观浮层）+ 底栏 */
export function SessionView(props: Props) {
  const { manager, session, scheme, connectedCount, lookOpen, onToggleLook, bottomTab, onBottomTab, findSeq, onToggleFind, onReconnect } = props;
  const bottomOpen = useStore(bottomPanelOpen);

  return (
    <>
      <section aria-label="终端" className="term-section">
        <TerminalView manager={manager} session={session} />
        {findSeq !== null && (
          <TerminalSearch
            key={session.id}
            manager={manager}
            sessionId={session.id}
            focusSeq={findSeq}
            onClose={() => {
              onToggleFind();
              manager.focus(session.id);
            }}
          />
        )}
        <CommandBar
          lookOpen={lookOpen}
          onToggleLook={onToggleLook}
          status={session.status}
          connectedCount={connectedCount}
          onSend={(cmd) => manager.sendCommand(session.id, cmd)}
          onSendAll={(cmd) => manager.sendToAll(cmd)}
          onToggleConnection={() => (session.status === 'connected' ? manager.disconnect(session.id) : onReconnect())}
          findOpen={findSeq !== null}
          onToggleFind={onToggleFind}
          onEditConnection={props.onEditConnection}
          bottomOpen={bottomOpen}
          onToggleBottom={() => bottomPanelOpen.set((open) => !open)}
        />
        {lookOpen && <AppearancePanel scheme={scheme} onClose={onToggleLook} />}
      </section>
      {bottomOpen && <BottomPanels manager={manager} session={session} tab={bottomTab} onTab={onBottomTab} />}
    </>
  );
}
