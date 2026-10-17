/** 交给浏览器下载：Blob + <a download>。返回文件名。桌面端 WKWebView 不支持，要走后端的 saveFile。 */
export function browserDownload(name: string, data: Uint8Array | string, mime = 'application/octet-stream'): string {
  // 拷一份成普通 ArrayBuffer 背书的数组，Blob 不接受 SharedArrayBuffer
  const part = typeof data === 'string' ? data : new Uint8Array(data);
  const url = URL.createObjectURL(new Blob([part], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 等浏览器接手下载后再释放
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}
