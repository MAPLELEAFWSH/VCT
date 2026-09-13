/* ============================================================
   electron/preload.js · 通过 contextBridge 暴露最小安全接口
   渲染进程拿不到 Node，只能用这里明确列出的方法
   ============================================================ */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mjDesktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('app:info'),
  getData: (key) => ipcRenderer.invoke('data:get', key),
  setData: (key, value) => ipcRenderer.invoke('data:set', key, value),
  exportData: (payload) => ipcRenderer.invoke('data:export', payload),
  importData: () => ipcRenderer.invoke('data:import'),
  openFiles: (opts) => ipcRenderer.invoke('dialog:open', opts || {}),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  // 外链走系统浏览器（顶栏百度检索、友链等）
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  /* 茶室：主进程是唯一知道"自己能不能被局域网访问"的一方
     （它才知道监听地址、真实网卡、端口），所以这些信息都问主进程要。 */
  chatInfo: () => ipcRenderer.invoke('chat:info'),
  chatSetLan: (on) => ipcRenderer.invoke('chat:setLan', !!on),
  chatSetCode: (code) => ipcRenderer.invoke('chat:setCode', String(code || '')),
  onMenu: (channel, fn) => {
    if (channel !== 'export' && channel !== 'import') return () => {};
    const h = () => fn();
    ipcRenderer.on('menu:' + channel, h);
    return () => ipcRenderer.removeListener('menu:' + channel, h);
  }
});
