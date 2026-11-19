// 让 TypeScript 接受纯 CSS 的副作用导入（Vite 负责实际打包）。
declare module "*.css";

/** 构建时的代码指纹（repo-003，vite.config.ts 注入）；开发模式是空串 */
declare const __APP_STAMP__: string;
