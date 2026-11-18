/**
 * 把导出的文件交给浏览器（DOM，无单测）：下载 blob；找不到 Edge / Chrome 时用隐藏 iframe 打开打印对话框。
 * 单篇导出（export-001）和整本导出（book-003）共用。
 */

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 下载开始前就回收地址会让部分浏览器下载失败：稍后再回收
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.className = "print-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.srcdoc = html;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // 打印对话框关掉以后再拿掉（拿不到 afterprint 就一分钟后拿掉）
    const remove = () => frame.remove();
    frame.contentWindow?.addEventListener("afterprint", remove);
    window.setTimeout(remove, 60_000);
  };
  document.body.appendChild(frame);
}
