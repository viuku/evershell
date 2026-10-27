// node.ts、store-sqlite.ts 用到的那几个 Node 接口的类型。
// 不装 @types/node：它和 @cloudflare/workers-types 都声明了 Request、Response 这些全局类型，
// 放在一起会互相冲突；这里只写用到的部分，用错了 vitest 会在真实的 Node 上报出来。

interface ImportMeta {
  url: string;
}

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  on(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
};

declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
}

declare module 'node:path' {
  export function dirname(path: string): string;
}

declare module 'node:http' {
  export interface IncomingMessage extends AsyncIterable<Uint8Array> {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    destroy(): void;
  }
  export interface ServerResponse {
    readonly headersSent: boolean;
    writeHead(status: number, headers?: Record<string, string>): this;
    end(chunk?: Uint8Array | string): void;
  }
  export interface Server {
    listen(port: number, listener?: () => void): this;
    close(callback?: (err?: Error) => void): this;
  }
  export function createServer(listener: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare module 'node:sqlite' {
  type SQLInputValue = null | number | bigint | string | Uint8Array;
  export interface StatementSync {
    all(...params: SQLInputValue[]): Record<string, unknown>[];
    get(...params: SQLInputValue[]): Record<string, unknown> | undefined;
    run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
