import { useState, useRef, useCallback } from 'react'
import Sidebar from './components/Sidebar'
import MySQLPanel from './components/MySQLPanel'
import RedisPanel from './components/RedisPanel'
import { invoke } from './ipc'

export type Connection = {
  id: string
  name: string
  type: 'mysql' | 'redis'
  config: any
}

export type Theme = 'dark' | 'light'

function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>('light')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(256)
  const [resizing, setResizing] = useState(false)
  // Per-connection open-tab requests: { db, table, seq }
  const [openRequestMap, setOpenRequestMap] = useState<Record<string, { db: string; table: string; seq: number }>>({})
  const openSeq = useRef(0)
  const isResizing = useRef(false)
  const resizeStartX = useRef(0)
  const resizeStartWidth = useRef(0)
  const previousUserSelect = useRef('')
  const previousCursor = useRef('')

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    setResizing(true)
    resizeStartX.current = e.clientX
    resizeStartWidth.current = sidebarWidth
    previousUserSelect.current = document.body.style.userSelect
    previousCursor.current = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const onMove = (ev: MouseEvent) => {
      if (!isResizing.current) return
      const newWidth = Math.max(160, Math.min(600, resizeStartWidth.current + ev.clientX - resizeStartX.current))
      setSidebarWidth(newWidth)
    }
    const onUp = () => {
      isResizing.current = false
      setResizing(false)
      document.body.style.userSelect = previousUserSelect.current
      document.body.style.cursor = previousCursor.current
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  const handleSelectTable = (db: string, table: string) => {
    if (!active) return
    const seq = ++openSeq.current
    setOpenRequestMap(m => ({ ...m, [active]: { db, table, seq } }))
  }

  const handleSelectDb = (db: string) => {
    if (!active) return
    const seq = ++openSeq.current
    setOpenRequestMap(m => ({ ...m, [active]: { db, table: '', seq } }))
  }

  // Called when user switches tabs in the panel — sync sidebar highlight without opening new tab
  const handleSyncLocation = (connId: string, db: string, table: string) => {
    setOpenRequestMap(m => {
      const cur = m[connId]
      if (!cur) return m
      return { ...m, [connId]: { ...cur, db, table } }
    })
  }

  const addConnection = (conn: Connection) => {
    setConnections(prev => {
      const exists = prev.find(c => c.id === conn.id)
      return exists ? prev : [...prev, conn]
    })
    setActive(conn.id)
  }

  const removeConnection = (id: string) => {
    invoke('disconnect', id)
    setConnections(prev => prev.filter(c => c.id !== id))
    if (active === id) setActive(null)
  }

  const updateConnection = (id: string, conn: Connection) => {
    setConnections(prev => prev.map(c => c.id === id ? conn : c))
  }

  const disconnectConnection = (id: string) => {
    invoke('disconnect', id)
    setConnections(prev => prev.filter(c => c.id !== id))
    if (active === id) setActive(null)
  }

  const activeConn = connections.find(c => c.id === active)
  const dark = theme === 'dark'

  document.title = activeConn ? `数据库管理工具 - ${activeConn.name}` : '数据库管理工具'

  return (
    <div className={`flex h-screen ${dark ? 'bg-[#1e1e1e] text-white' : 'bg-white text-gray-900'}`}
      style={{ colorScheme: theme }}>
      <style>{`
        * { scrollbar-width: thin; scrollbar-color: ${dark ? '#303030 #2a2a2a' : '#e6e6e6 #f0f0f0'}; }
        ::-webkit-scrollbar { width: 12px; height: 12px; }
        ::-webkit-scrollbar-track { background: ${dark ? '#2a2a2a' : '#f0f0f0'}; }
        ::-webkit-scrollbar-thumb { background: ${dark ? '#303030' : '#e6e6e6'}; border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: ${dark ? '#4a4a4a' : '#bbb'}; }
        ::-webkit-scrollbar-thumb:active { background: ${dark ? '#5a5a5a' : '#999'}; }
        ::-webkit-scrollbar-corner { background: ${dark ? '#2a2a2a' : '#f0f0f0'}; }
      `}</style>

      <div className="relative flex-shrink-0 flex">
        <div style={{ width: sidebarOpen ? sidebarWidth : 0, overflow: 'hidden', transition: resizing ? 'none' : 'width 0.2s ease' }}>
          <Sidebar
            connections={connections}
            active={active}
            onSelect={id => { setActive(id) }}
            onAdd={addConnection}
            onRemove={removeConnection}
            onUpdate={updateConnection}
            onReconnect={() => {}}
            onDisconnect={disconnectConnection}
            theme={theme}
            onThemeToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
            selectedDb={active ? (openRequestMap[active]?.db || '') : ''}
            selectedTable={active ? (openRequestMap[active]?.table || '') : ''}
            onSelectTable={handleSelectTable}
            onSelectDb={handleSelectDb}
            width={sidebarWidth}
          />
        </div>
        {sidebarOpen && (
          <div
            onMouseDown={onResizeStart}
            style={{ left: sidebarWidth - 3, cursor: 'col-resize' }}
            className={`absolute top-0 bottom-0 w-1 z-30 hover:bg-blue-400 opacity-0 hover:opacity-100`}
            title="拖动调整宽度"
          />
        )}
        <button
          onClick={() => setSidebarOpen(o => !o)}
          title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          style={{ left: sidebarOpen ? sidebarWidth - 3 : 0, transition: 'left 0.2s ease' }}
          className={`absolute top-1/2 -translate-y-1/2 z-20 w-3 h-10 flex items-center justify-center rounded-r border-y border-r text-xs shadow ${dark ? 'bg-[#252526] border-[#3e3e42] hover:bg-[#3e3e42]' : 'bg-gray-100 border-gray-300 hover:bg-gray-200'}`}
        >
          {sidebarOpen ? '‹' : '›'}
        </button>
      </div>

      <div className="flex-1 overflow-hidden relative">
        {connections.filter(c => c.type === 'mysql').map(c => (
          <div key={c.id} style={{ display: active === c.id ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
            <MySQLPanel
              connection={c}
              theme={theme}
              requestedDb={openRequestMap[c.id]?.db || ''}
              requestedTable={openRequestMap[c.id]?.table || ''}
              requestedSeq={openRequestMap[c.id]?.seq}
              onTabChange={(db, table) => handleSyncLocation(c.id, db, table)}
              onSelectDb={handleSelectDb}
            />
          </div>
        ))}
        {connections.filter(c => c.type === 'redis').map(c => (
          <div key={c.id} style={{ display: active === c.id ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
            <RedisPanel connection={c} theme={theme} />
          </div>
        ))}
        {!activeConn && (
          <div className={`flex items-center justify-center h-full ${dark ? 'text-gray-500' : 'text-gray-400'}`}>
            选择或创建一个连接
          </div>
        )}
      </div>
    </div>
  )
}

export default App
