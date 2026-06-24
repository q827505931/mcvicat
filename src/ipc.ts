// In Electron renderer with nodeIntegration: true, we can require electron directly
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ipcRenderer } = (window as any).require('electron')

export function invoke(channel: string, ...args: any[]): Promise<any> {
  return ipcRenderer.invoke(channel, ...args)
}
