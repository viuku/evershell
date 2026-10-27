/** 构建时注入前端的环境变量（vite.config.ts 的 envPrefix 决定哪些能进来） */
interface ImportMetaEnv {
  /** Tauri CLI 在 `tauri dev`、`tauri build --debug` 时设为 "true"，正式的 `tauri build` 不设 */
  readonly TAURI_ENV_DEBUG?: string;
}
