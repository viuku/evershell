import type { SessionInfo, SessionManager } from '../core/session-manager';
import type { Scheme } from '../core/settings';
import { BottomPanels, type BottomTab } from './panels/BottomPanels';
import { AppearancePanel } from './terminal/AppearancePanel';
import { CommandBar } from './terminal/CommandBar';
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
}

/** 一个会话标签的内容：终端 + 命令栏（含外观浮层）+ 底部面板 */
export function SessionView({ manager, session, scheme, connectedCount, lookOpen, onToggleLook, bottomTab, onBottomTab }: Props) {
  return (
    <>
      <section aria-label="终端" className="term-section">
        <TerminalView manager={manager} session={session} />
        <CommandBar
          lookOpen={lookOpen}
          onToggleLook={onToggleLook}
          connected={session.status === 'connected'}
          connectedCount={connectedCount}
          onSend={(cmd) => manager.sendCommand(session.id, cmd)}
          onSendAll={(cmd) => manager.sendToAll(cmd)}
        />
        {lookOpen && <AppearancePanel scheme={scheme} onClose={onToggleLook} />}
      </section>
      <BottomPanels manager={manager} session={session} tab={bottomTab} onTab={onBottomTab} />
    </>
  );
}
