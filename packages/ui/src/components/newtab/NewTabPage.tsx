import { useEffect, useState } from 'react';
import { formatRelative } from '../../core/format';
import { folderPath, getFolder, hostsStore, type ServerRecord } from '../../core/hosts-store';
import { clearRecents, recentsStore } from '../../core/recents-store';
import { useStore } from '../../core/store';
import { ServerIcon } from '../common/Icons';

interface Props {
  onConnect(server: ServerRecord): void;
  onOpenManager(): void;
}

/** 新标签页：快速连接最近用过的服务器 */
export function NewTabPage({ onConnect, onOpenManager }: Props) {
  const recents = useStore(recentsStore);
  const hosts = useStore(hostsStore);
  // 每分钟刷新一次“x 分钟前”
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const rows = recents
    .map((r) => ({ at: r.at, server: hosts.servers.find((s) => s.id === r.serverId) ?? null }))
    .filter((r): r is { at: number; server: ServerRecord } => !!r.server && !r.server.deletedAt);

  return (
    <main className="newtab scroll">
      <section aria-label="快速连接" className="quick">
        <div className="quick__head">
          <strong>快速连接</strong>
          <span className="muted">最近连接过的服务器，点一下就连</span>
          <button type="button" className="btn quick__manager" onClick={onOpenManager}>
            连接管理器…
          </button>
          <button type="button" className="btn" disabled={rows.length === 0} onClick={clearRecents}>
            清空
          </button>
        </div>
        {rows.length > 0 ? (
          <div>
            <div className="grid-head quick__cols quick__colsHead">
              <span>名称</span>
              <span>位置</span>
              <span>用户名</span>
              <span>上次连接</span>
            </div>
            <div className="scroll quick__list">
              {rows.map(({ server, at }) => {
                const folder = getFolder(hosts, server.parentId);
                const path = folder ? folderPath(hosts, folder.id) : '/';
                return (
                  <button key={server.id} type="button" className="grid-row quick__cols quick__row" onClick={() => onConnect(server)}>
                    <span className="quick__name">
                      <ServerIcon size={16} />
                      <span className="ellipsis">{server.name}</span>
                    </span>
                    <span className="muted ellipsis">{path}</span>
                    <span className="muted ellipsis">{server.user}</span>
                    <span className="muted">{formatRelative(at)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="empty quick__empty">还没有最近连接。点左上角的文件夹图标打开连接管理器。</div>
        )}
      </section>
    </main>
  );
}
