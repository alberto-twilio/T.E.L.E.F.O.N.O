const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  info: invoke('app:info'),
  listProfiles: invoke('profiles:list'),
  saveProfile: invoke('profiles:save'),
  deleteProfile: invoke('profiles:delete'),
  duplicateProfile: invoke('profiles:duplicate'),
  listRuns: invoke('runs:list'),
  getRun: invoke('runs:get'),
  startRun: invoke('run:start'),
  stopRun: invoke('run:stop'),
  onRunLog: subscribe('run:log'),
  onRunUpdate: subscribe('run:update'),
  onRunProgress: subscribe('run:progress'),
});
