import { useState } from 'react'
import { Connection, Theme } from '../App'
import { invoke } from '../ipc'

type Props = { connection: Connection; theme: Theme }
type KeyType = 'string' | 'list' | 'hash' | 'set' | 'zset' | 'unknown'

export default function RedisPanel({ connection, theme }: Props) {
  const [pattern, setPattern] = useState('*')
  const [keys, setKeys] = useState<string[]>([])
  const [selectedKey, setSelectedKey] = useState('')
  const [keyType, setKeyType] = useState<KeyType>('unknown')
  const [value, setValue] = useState<any>(null)
  const [editValue, setEditValue] = useState('')
  const [command, setCommand] = useState('')
  const [cmdResult, setCmdResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)

  const dark = theme === 'dark'
  const bg = dark ? 'bg-[#1e1e1e]' : 'bg-white'
  const bg2 = dark ? 'bg-[#252526]' : 'bg-gray-50'
  const border = dark ? 'border-[#3e3e42]' : 'border-gray-300'
  const text = dark ? 'text-white' : 'text-gray-900'
  const textSub = dark ? 'text-gray-400' : 'text-gray-500'
  const hover = dark ? 'hover:bg-[#2a2d2e]' : 'hover:bg-gray-100'
  const inputCls = `${bg} border ${border} rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500 ${text}`

  const loadKeys = async () => {
    setLoading(true)
    const k = await invoke('redis:keys', { id: connection.id, pattern })
    setKeys(k.sort())
    setLoading(false)
  }

  const loadKey = async (key: string) => {
    setSelectedKey(key)
    const typeRes = await invoke('redis:command', { id: connection.id, cmd: 'type', args: [key] })
    const t: KeyType = typeRes.success ? typeRes.data : 'unknown'
    setKeyType(t)
    if (t === 'string') {
      const r = await invoke('redis:command', { id: connection.id, cmd: 'get', args: [key] })
      setValue(r.data); setEditValue(r.data || '')
    } else if (t === 'list') {
      const r = await invoke('redis:command', { id: connection.id, cmd: 'lrange', args: [key, '0', '-1'] })
      setValue(r.data); setEditValue(Array.isArray(r.data) ? r.data.join('\n') : '')
    } else if (t === 'hash') {
      const r = await invoke('redis:command', { id: connection.id, cmd: 'hgetall', args: [key] })
      setValue(r.data); setEditValue(typeof r.data === 'object' ? JSON.stringify(r.data, null, 2) : '')
    } else if (t === 'set') {
      const r = await invoke('redis:command', { id: connection.id, cmd: 'smembers', args: [key] })
      setValue(r.data); setEditValue(Array.isArray(r.data) ? r.data.join('\n') : '')
    } else if (t === 'zset') {
      const r = await invoke('redis:command', { id: connection.id, cmd: 'zrange', args: [key, '0', '-1', 'WITHSCORES'] })
      setValue(r.data); setEditValue(Array.isArray(r.data) ? r.data.join('\n') : '')
    }
  }

  const saveValue = async () => {
    if (keyType === 'string') {
      const r = await invoke('redis:command', { id: connection.id, cmd: 'set', args: [selectedKey, editValue] })
      if (!r.success) alert('保存失败: ' + r.error)
    } else {
      alert(`${keyType} 类型暂不支持直接编辑，请使用命令行操作`)
    }
  }

  const deleteKey = async (key: string) => {
    if (!confirm(`确定删除 ${key}?`)) return
    await invoke('redis:command', { id: connection.id, cmd: 'del', args: [key] })
    setKeys(keys.filter(k => k !== key))
    if (selectedKey === key) { setSelectedKey(''); setValue(null) }
  }

  const executeCommand = async () => {
    const parts = command.trim().split(/\s+/)
    if (!parts[0]) return
    const r = await invoke('redis:command', { id: connection.id, cmd: parts[0], args: parts.slice(1) })
    setCmdResult(r)
    if (r.success && selectedKey) loadKey(selectedKey)
  }

  const typeColor: Record<KeyType, string> = {
    string: 'text-green-500', list: 'text-blue-500', hash: 'text-yellow-500',
    set: 'text-purple-500', zset: 'text-pink-500', unknown: textSub
  }

  return (
    <div className={`flex h-full ${bg} ${text}`}>
      {/* Key list */}
      <div className={`w-64 ${bg2} border-r ${border} flex flex-col`}>
        <div className={`p-3 border-b ${border} space-y-2`}>
          <input
            value={pattern}
            onChange={e => setPattern(e.target.value)}
            placeholder="Key 匹配模式"
            className={`w-full ${inputCls}`}
            onKeyDown={e => e.key === 'Enter' && loadKeys()}
          />
          <button onClick={loadKeys} disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-1.5 rounded text-sm disabled:opacity-50">
            {loading ? '加载中...' : '扫描 Keys'}
          </button>
          {keys.length > 0 && <div className={`text-xs ${textSub}`}>{keys.length} 个 Key</div>}
        </div>
        <div className="flex-1 overflow-y-auto">
          {keys.map(key => (
            <div
              key={key}
              onClick={() => loadKey(key)}
              className={`group flex items-center justify-between px-3 py-1.5 cursor-pointer ${hover} border-b ${border} ${selectedKey === key ? (dark ? 'bg-[#37373d]' : 'bg-blue-50') : ''}`}
            >
              <span className="text-sm truncate flex-1">{key}</span>
              <button onClick={e => { e.stopPropagation(); deleteKey(key) }} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-500 ml-1">
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Value editor + command */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedKey && (
          <div className={`border-b ${border} p-3 flex-shrink-0`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{selectedKey}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${dark ? 'bg-[#3e3e42]' : 'bg-gray-200'} ${typeColor[keyType]}`}>{keyType}</span>
              </div>
              <div className="flex gap-2">
                {keyType === 'string' && (
                  <button onClick={saveValue} className="px-3 py-1 bg-green-600 hover:bg-green-700 text-white rounded text-sm">保存</button>
                )}
                <button onClick={() => deleteKey(selectedKey)} className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-sm">删除</button>
              </div>
            </div>
            {keyType === 'string' ? (
              <textarea
                value={editValue}
                onChange={e => setEditValue(e.target.value)}
                className={`w-full ${bg} border ${border} rounded p-3 font-mono text-sm h-36 resize-none focus:outline-none focus:border-blue-500 ${text}`}
              />
            ) : (
              <pre className={`${bg} border ${border} rounded p-3 text-sm h-36 overflow-auto`}>
                {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '')}
              </pre>
            )}
          </div>
        )}

        <div className="flex-1 p-3 flex flex-col">
          <div className={`text-xs ${textSub} mb-2`}>命令行 (Enter 执行)</div>
          <div className="flex gap-2 mb-3">
            <input
              value={command}
              onChange={e => setCommand(e.target.value)}
              placeholder="例: KEYS * / SET foo bar / TTL key"
              className={`flex-1 ${bg} border ${border} rounded px-3 py-2 font-mono text-sm focus:outline-none focus:border-blue-500 ${text}`}
              onKeyDown={e => e.key === 'Enter' && executeCommand()}
            />
            <button onClick={executeCommand} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm">
              执行
            </button>
          </div>
          {cmdResult && (
            <div className={`p-3 rounded border text-sm font-mono overflow-auto flex-1 ${
              cmdResult.success ? `${bg} ${border}` : 'bg-red-50 border-red-400 text-red-700'
            }`}>
              {cmdResult.success
                ? typeof cmdResult.data === 'object' ? JSON.stringify(cmdResult.data, null, 2) : String(cmdResult.data ?? '(nil)')
                : cmdResult.error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
