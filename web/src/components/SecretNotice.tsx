import { useEffect, useState } from "react";
import * as api from "../api.ts";
import type { SecretStatus } from "../api.ts";

/**
 * 密钥加密存放的说明（sec-001），放在 AI 服务商 / AI 网关 / 备份设置里填密钥的地方下面：
 * - 一行小字：加密保存，钥匙在哪，换电脑要一起拷；
 * - 有已保存的密钥解不开时，多一条提示让人重填或把原来的 secret.key 放回去。
 * refresh 变了就重新读一次（保存之后）。
 */
export default function SecretNotice({ refresh = 0 }: { refresh?: number }) {
  const [status, setStatus] = useState<SecretStatus | null>(null);

  useEffect(() => {
    let alive = true;
    api.getSecretStatus().then(
      (value) => {
        if (alive) setStatus(value);
      },
      () => {
        if (alive) setStatus(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [refresh]);

  if (!status) return null;
  const folder = status.keyPath.replace(/[\\/][^\\/]*$/, "");
  return (
    <>
      {status.unreadable > 0 ? (
        <p className="secret-notice secret-notice--warn" role="alert">
          有 {status.unreadable} 处已保存的密钥在这台电脑上解不开（钥匙文件不在或不对），请重新填写；如果有原来电脑上的 secret.key，放回
          <code>{folder}</code> 也行。
        </p>
      ) : null}
      <p className="secret-notice">
        密钥加密保存，钥匙在 <code>{status.keyPath}</code>。换电脑时把它一起拷过去，否则要重新填。
      </p>
    </>
  );
}
