import { useState, useEffect, useRef } from 'react'
import { Connection, Theme } from '../App'
import { invoke } from '../ipc'
import haitunGray from '../assets/haitun.png'
import haitunGreen from '../assets/haitun-2.png'

type Props = {
  connections: Connection[]
  active: string | null
  onSelect: (id: string) => void
  onAdd: (conn: Connection) => void
  onRemove: (id: string) => void
  onUpdate: (id: string, conn: Connection) => void
  onReconnect: (id: string) => void
  onDisconnect: (id: string) => void
  theme: Theme
  onThemeToggle: () => void
  selectedDb: string
  selectedTable: string
  onSelectTable: (db: string, table: string) => void
  onSelectDb: (db: string) => void
  width?: number
}

type SavedProfile = {
  name: string
  type: 'mysql' | 'redis'
  host: string
  port: string
  user: string
  database: string
  password: string
}

const STORAGE_KEY = 'db-manager-profiles'
const STORAGE_V2_KEY = 'db-manager-profiles-v2'

function loadProfiles(): SavedProfile[] {
  try {
    if (!localStorage.getItem(STORAGE_V2_KEY)) {
      localStorage.removeItem(STORAGE_KEY)
      localStorage.setItem(STORAGE_V2_KEY, '1')
      return []
    }
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
  } catch { return [] }
}

function saveProfiles(p: SavedProfile[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
}

const visibleDbsStorageKey = (profileName: string) => `visible-dbs-profile-${profileName}`
const legacyVisibleDbsStorageKey = (connId: string) => `visible-dbs-${connId}`

function loadVisibleDbs(profileName: string, connId: string, fallback: string[]) {
  try {
    const saved = localStorage.getItem(visibleDbsStorageKey(profileName))
    if (saved) return new Set<string>(JSON.parse(saved))

    const legacySaved = localStorage.getItem(legacyVisibleDbsStorageKey(connId))
    if (legacySaved) {
      localStorage.setItem(visibleDbsStorageKey(profileName), legacySaved)
      return new Set<string>(JSON.parse(legacySaved))
    }
  } catch {}
  return new Set<string>(fallback)
}

function saveVisibleDbsForProfile(profileName: string, connId: string, dbs: Set<string>) {
  const value = JSON.stringify(Array.from(dbs))
  localStorage.setItem(visibleDbsStorageKey(profileName), value)
  localStorage.setItem(legacyVisibleDbsStorageKey(connId), value)
}

const emptyForm = { name: '', host: '', port: '', user: '', password: '', database: '' }

export default function Sidebar({ connections, active, onSelect, onAdd, onRemove, onUpdate, onReconnect, onDisconnect, theme, onThemeToggle, selectedDb, selectedTable, onSelectTable, onSelectDb, width = 256 }: Props) {
  const [profiles, setProfiles] = useState<SavedProfile[]>(loadProfiles)
  const [showForm, setShowForm] = useState(false)
  const [editingProfile, setEditingProfile] = useState<string | null>(null) // profile name being edited
  const [type, setType] = useState<'mysql' | 'redis'>('mysql')
  const [form, setForm] = useState(emptyForm)
  const [connecting, setConnecting] = useState<string | null>(null) // profile name being connected
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; profileName: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null) // profile name
  const [showDbFilter, setShowDbFilter] = useState<{ profileName: string; connId: string } | null>(null)
  const [databases, setDatabases] = useState<string[]>([])
  const [visibleDbs, setVisibleDbs] = useState<Set<string>>(new Set())
  const contextMenuRef = useRef<HTMLDivElement>(null)

  // Tree state for db/table navigation
  const [treeDatabases, setTreeDatabases] = useState<string[]>([])
  const [treeTables, setTreeTables] = useState<{ db: string; list: string[] }[]>([])
  const [treeExpandedDbs, setTreeExpandedDbs] = useState<Set<string>>(new Set())
  const [treeVisibleDbs, setTreeVisibleDbs] = useState<Set<string>>(new Set())
  const [treeTableSearch, setTreeTableSearch] = useState('')
  const [showTreeDbFilter, setShowTreeDbFilter] = useState(false)
  const [treeCollapsed, setTreeCollapsed] = useState(false)

  const dark = theme === 'dark'
  const bg = dark ? 'bg-[#252526]' : 'bg-gray-50'
  const border = dark ? 'border-[#3e3e42]' : 'border-gray-200'
  const hover = dark ? 'hover:bg-[#2a2d2e]' : 'hover:bg-gray-100'
  const text = dark ? 'text-white' : 'text-gray-900'
  const textSub = dark ? 'text-gray-500' : 'text-gray-400'
  const inputCls = `w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500 ${dark ? 'bg-[#3c3c3c] border-[#3e3e42] text-white' : 'bg-white border-gray-300 text-gray-900'}`
  const bottomControlSurface = dark
    ? 'bg-[#1f1f20]/85 border-white/10 shadow-black/30'
    : 'bg-white/80 border-white/70 shadow-gray-200/80'
  const bottomControlHover = dark ? 'hover:bg-white/10 active:bg-white/15' : 'hover:bg-white active:bg-gray-100'

  // Close context menu on outside click
  useEffect(() => {
    const handler = () => setContextMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [])

  // Load databases when active MySQL connection changes
  const activeConn = connections.find(c => c.id === active)
  const activeMysqlConn = activeConn?.type === 'mysql' ? activeConn : null

  useEffect(() => {
    if (!activeMysqlConn) {
      setTreeDatabases([])
      setTreeTables([])
      setTreeExpandedDbs(new Set())
      setTreeVisibleDbs(new Set())
      return
    }
    setTreeCollapsed(false)
    setTreeTableSearch('')
    setTreeTables([])
    setTreeExpandedDbs(new Set())
    const connId = activeMysqlConn.id
    const profileName = activeMysqlConn.name
    invoke('mysql:databases', connId).then((dbs: string[]) => {
      setTreeDatabases(dbs)
      setTreeVisibleDbs(loadVisibleDbs(profileName, connId, dbs))
    })
  }, [active])

  const scrollSidebarItemIntoView = (el: Element | null) => {
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // When selectedDb/selectedTable changes (driven by tab switch), expand and scroll to locate
  useEffect(() => {
    if (!selectedDb) return
    // Expand the tree if collapsed
    setTreeCollapsed(false)
    // Expand the db if collapsed, and load tables if needed
    setTreeExpandedDbs(prev => {
      if (prev.has(selectedDb)) return prev
      const next = new Set(prev)
      next.add(selectedDb)
      return next
    })
    if (!treeTables.find(t => t.db === selectedDb) && activeMysqlConn) {
      invoke('mysql:tables', { id: activeMysqlConn.id, db: selectedDb }).then((list: string[]) => {
        setTreeTables(prev => [...prev.filter(t => t.db !== selectedDb), { db: selectedDb, list }])
      })
    }
    // Scroll after render
    setTimeout(() => {
      if (selectedTable) {
        const el = document.querySelector(`[data-sidebar-table="${selectedDb}::${selectedTable}"]`)
        scrollSidebarItemIntoView(el)
      } else {
        const el = document.querySelector(`[data-sidebar-db="${selectedDb}"]`)
        scrollSidebarItemIntoView(el)
      }
    }, 80)
  }, [selectedDb, selectedTable])

  // After tables load, re-scroll to the target table if needed
  useEffect(() => {
    if (!selectedTable || !selectedDb) return
    const el = document.querySelector(`[data-sidebar-table="${selectedDb}::${selectedTable}"]`)
    scrollSidebarItemIntoView(el)
  }, [treeTables])

  const saveTreeVisibleDbs = (conn: Connection, dbs: Set<string>) => {
    saveVisibleDbsForProfile(conn.name, conn.id, dbs)
    setTreeVisibleDbs(dbs)
  }

  const toggleTreeDb = async (db: string) => {
    const next = new Set(treeExpandedDbs)
    if (next.has(db)) {
      next.delete(db)
    } else {
      next.add(db)
      if (!treeTables.find(t => t.db === db) && activeMysqlConn) {
        const list = await invoke('mysql:tables', { id: activeMysqlConn.id, db })
        setTreeTables(prev => [...prev.filter(t => t.db !== db), { db, list }])
      }
    }
    setTreeExpandedDbs(next)
  }

  const iconFor = (t: string) => t === 'mysql' ? '🐬' : '🔴'

  const getConnByName = (name: string) => connections.find(c => c.name === name)

  const openNewForm = () => {
    setEditingProfile(null)
    setType('mysql')
    setForm(emptyForm)
    setShowForm(true)
  }

  const openEditForm = (profileName: string) => {
    const p = profiles.find(x => x.name === profileName)
    if (!p) return
    setEditingProfile(profileName)
    setType(p.type)
    setForm({ name: p.name, host: p.host, port: p.port, user: p.user, password: p.password, database: p.database })
    setShowForm(true)
    setContextMenu(null)
  }

  const connect = async (profileName?: string) => {
    const targetName = profileName ?? (editingProfile ?? form.name)
    if (!form.name.trim()) { alert('请输入连接名称'); return }
    setConnecting(targetName)
    const config = type === 'mysql'
      ? { host: form.host, port: +form.port || 3306, user: form.user, password: form.password }
      : { host: form.host, port: +form.port || 6379, password: form.password || undefined }
    const result = await invoke(`${type}:connect`, config)
    setConnecting(null)
    if (result.success) {
      const profile: SavedProfile = { name: form.name, type, host: form.host, port: form.port, user: form.user, database: form.database, password: form.password }
      const newProfiles = [profile, ...loadProfiles().filter(p => p.name !== profile.name)].slice(0, 50)
      saveProfiles(newProfiles)
      setProfiles(newProfiles)
      const conn: Connection = { id: result.id, name: form.name, type, config }
      if (editingProfile && editingProfile !== form.name) {
        // name changed — remove old, add new
        const old = getConnByName(editingProfile)
        if (old) onRemove(old.id)
      }
      const existing = getConnByName(form.name)
      if (existing) {
        onUpdate(existing.id, { ...existing, config })
      } else {
        onAdd(conn)
      }
      setShowForm(false)
      setForm(emptyForm)
      setEditingProfile(null)
    } else {
      alert('连接失败: ' + result.error)
    }
  }

  const handleConnectProfile = async (p: SavedProfile) => {
    const existing = getConnByName(p.name)
    if (existing) { onSelect(existing.id); return }
    setConnecting(p.name)
    const config = p.type === 'mysql'
      ? { host: p.host, port: +p.port || 3306, user: p.user, password: p.password }
      : { host: p.host, port: +p.port || 6379, password: p.password || undefined }
    const result = await invoke(`${p.type}:connect`, config)
    setConnecting(null)
    if (result.success) {
      onAdd({ id: result.id, name: p.name, type: p.type, config })
    } else {
      alert('连接失败: ' + result.error)
    }
  }

  const handleDisconnect = (profileName: string) => {
    const conn = getConnByName(profileName)
    if (conn) { onDisconnect(conn.id) }
    setContextMenu(null)
  }

  const handleReconnect = async (profileName: string) => {
    const p = profiles.find(x => x.name === profileName)
    if (!p) return
    setContextMenu(null)
    const old = getConnByName(profileName)
    if (old) onDisconnect(old.id)
    setConnecting(profileName)
    const config = p.type === 'mysql'
      ? { host: p.host, port: +p.port || 3306, user: p.user, password: p.password }
      : { host: p.host, port: +p.port || 6379, password: p.password || undefined }
    const result = await invoke(`${p.type}:connect`, config)
    setConnecting(null)
    if (result.success) {
      onAdd({ id: result.id, name: p.name, type: p.type, config })
    } else {
      alert('重连失败: ' + result.error)
    }
  }

  const handleRemoveProfile = (profileName: string) => {
    const conn = getConnByName(profileName)
    if (conn) onRemove(conn.id)
    const newProfiles = profiles.filter(p => p.name !== profileName)
    saveProfiles(newProfiles)
    setProfiles(newProfiles)
    setConfirmRemove(null)
  }

  const openDbFilter = async (profileName: string) => {
    const conn = getConnByName(profileName)
    if (!conn) return
    setContextMenu(null)
    const dbs: string[] = await invoke('mysql:databases', conn.id)
    const visible = loadVisibleDbs(profileName, conn.id, dbs)
    setDatabases(dbs)
    setVisibleDbs(visible)
    setShowDbFilter({ profileName, connId: conn.id })
  }

  const saveVisibleDbs = (profileName: string, connId: string, dbs: Set<string>) => {
    saveVisibleDbsForProfile(profileName, connId, dbs)
    setVisibleDbs(dbs)
  }

  return (
    <div className={`${bg} border-r ${border} flex flex-col h-full ${text}`} style={{ width }}>

      {/* Connection list */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {profiles.length === 0 && (
          <div className={`p-6 text-sm text-center ${textSub}`}>暂无连接，点击下方 + 新建</div>
        )}
        <div className="flex-shrink-0">
          {profiles.map(p => {
            const conn = getConnByName(p.name)
            const isConnected = !!conn
            const isActive = conn ? active === conn.id : false
            const isConnecting = connecting === p.name
            const isActiveMysql = isActive && isConnected && p.type === 'mysql'
            return (
              <div
                key={p.name}
                onClick={() => {
                  if (isActiveMysql) {
                    setTreeCollapsed(c => !c)
                  } else {
                    handleConnectProfile(p)
                  }
                }}
                onContextMenu={e => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, profileName: p.name }) }}
                className={`mx-2 my-1 px-3 py-2 cursor-pointer flex items-center gap-2 overflow-hidden rounded-xl transition-colors ${
                  isActive
                    ? (dark ? 'bg-[#3f4652] shadow-sm ring-1 ring-white/10' : 'bg-blue-100 shadow-sm ring-1 ring-blue-200')
                    : `${hover} ${dark ? 'bg-[#252526] hover:bg-[#303033]' : 'bg-white hover:bg-gray-100'} shadow-sm ring-1 ${dark ? 'ring-white/5' : 'ring-gray-200'}`
                }`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isConnected ? 'bg-green-500' : (dark ? 'bg-gray-600' : 'bg-gray-300')}`} />
                <span className="text-sm">{iconFor(p.type)}</span>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm truncate font-semibold ${isActive ? (dark ? 'text-blue-300' : 'text-blue-700') : ''}`}>{p.name}</div>
                  <div className={`text-xs truncate ${textSub}`}>{p.host}:{p.port || (p.type === 'mysql' ? '3306' : '6379')}</div>
                </div>
                {isConnecting && <span className={`text-xs ${textSub} flex-shrink-0`}>连接中...</span>}
                {isActiveMysql && <span className={`text-xs ${textSub} flex-shrink-0`}>{treeCollapsed ? '▸' : '▾'}</span>}
              </div>
            )
          })}
        </div>

        {activeMysqlConn && !treeCollapsed && (
          <div className={`border-b ${border} flex-1 min-h-0 flex flex-col overflow-hidden`}>
            <div className={`mx-2 mt-1 mb-2 p-1.5 flex-shrink-0 flex items-center gap-1.5 rounded-xl shadow-sm ring-1 ${dark ? 'bg-[#252526] ring-white/10' : 'bg-white ring-gray-200'}`}>
              <div className="relative flex-1 min-w-0">
                <input
                  value={treeTableSearch}
                  onChange={e => setTreeTableSearch(e.target.value)}
                  placeholder="搜索表名..."
                  className={`w-full text-xs pl-2.5 pr-7 py-1.5 rounded-lg border focus:outline-none focus:border-blue-500 ${dark ? 'bg-[#1f1f20] border-[#3e3e42] text-white placeholder:text-gray-500' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder:text-gray-400'}`}
                />
                {treeTableSearch && (
                  <button
                    onClick={() => setTreeTableSearch('')}
                    className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${dark ? 'bg-[#3e3e42] text-gray-300 hover:bg-[#555]' : 'bg-gray-200 text-gray-500 hover:bg-gray-300'}`}
                    title="清空搜索"
                  >×</button>
                )}
              </div>
              <button
                onClick={e => { e.stopPropagation(); setShowTreeDbFilter(true) }}
                title="筛选数据库"
                className={`text-xs px-2 py-1.5 rounded-lg border flex-shrink-0 ${dark ? 'border-[#3e3e42] hover:bg-[#3e3e42]' : 'border-gray-200 hover:bg-gray-100'}`}
              >⚙</button>
            </div>
            <div className="mx-2 pb-2 space-y-0.5 overflow-auto scrollbar-thin flex-1 min-h-0">
              {treeDatabases.filter(db => treeVisibleDbs.has(db)).map(db => {
                const expanded = treeExpandedDbs.has(db)
                const tblEntry = treeTables.find(t => t.db === db)
                const searchLower = treeTableSearch.toLowerCase()
                const dbMatches = searchLower && db.toLowerCase().includes(searchLower)
                const filteredList = tblEntry
                  ? (treeTableSearch
                      ? (dbMatches ? tblEntry.list : tblEntry.list.filter(t => t.toLowerCase().includes(searchLower)))
                      : tblEntry.list)
                  : []
                if (treeTableSearch && !dbMatches && filteredList.length === 0) return null
                return (
                  <div key={db}>
                    <div
                      data-sidebar-db={db}
                      onClick={e => { e.stopPropagation(); const expanding = !treeExpandedDbs.has(db); toggleTreeDb(db); if (expanding) onSelectDb(db) }}
                      className={`flex items-center gap-1 px-3 py-1.5 cursor-pointer rounded-lg ${hover} text-sm select-none ${dark ? 'hover:bg-[#303033]' : 'hover:bg-gray-100'}`}
                    >
                      <span className={textSub}>{expanded ? '▾' : '▸'}</span>
                      <img src={expanded ? haitunGreen : haitunGray} className="w-4 h-4 flex-shrink-0" alt="" />
                      <span>{db}</span>
                    </div>
                    {expanded && tblEntry && (
                      <div>
                        {filteredList.map(tbl => {
                          const isSel = selectedTable === tbl && selectedDb === db
                          return (
                            <div
                              key={tbl}
                              data-sidebar-table={`${db}::${tbl}`}
                              onClick={e => { e.stopPropagation(); onSelectTable(db, tbl) }}
                              className={`flex items-center gap-1 ml-6 px-3 py-1.5 cursor-pointer text-sm rounded-lg ${
                                isSel ? (dark ? 'bg-blue-600 text-white shadow-sm' : 'bg-blue-500 text-white shadow-sm') : `${hover} ${text} ${dark ? 'hover:bg-[#303033]' : 'hover:bg-gray-100'}`
                              }`}
                            >
                              <span className={isSel ? 'text-blue-200' : 'text-blue-400'}>▤</span>
                              <span>{tbl}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Bottom toolbar */}
      <div className={`h-[47px] box-border border-t ${border} px-3 py-1.5 flex items-center justify-between gap-2 flex-shrink-0 ${dark ? 'bg-[#202022]/70' : 'bg-gray-50/70'} backdrop-blur-xl`}>
        <button
          onClick={openNewForm}
          title="新建连接"
          className={`group h-9 flex-1 rounded-2xl border ${bottomControlSurface} ${bottomControlHover} shadow-lg transition-all duration-200 flex items-center justify-center gap-1.5 text-sm font-medium ${dark ? 'text-blue-300' : 'text-blue-600'}`}
        >
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-base leading-none transition-transform group-hover:scale-110 ${dark ? 'bg-blue-500/20' : 'bg-blue-100'}`}>＋</span>
          <span className="text-xs">新建连接</span>
        </button>
        <button
          onClick={onThemeToggle}
          title={dark ? '切换到浅色模式' : '切换到深色模式'}
          className={`group h-9 w-12 rounded-2xl border ${bottomControlSurface} ${bottomControlHover} shadow-lg transition-all duration-200 flex items-center justify-center`}
        >
          <span className="flex h-6 w-6 items-center justify-center text-sm transition-transform group-hover:rotate-12 group-hover:scale-110">
            {dark ? '☀️' : '🌙'}
          </span>
        </button>
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          onClick={e => e.stopPropagation()}
          className={`fixed z-50 rounded border shadow-xl py-1 min-w-[160px] ${dark ? 'bg-[#252526] border-[#3e3e42]' : 'bg-white border-gray-200'}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {(() => {
            const profileName = contextMenu.profileName
            const conn = getConnByName(profileName)
            const isConnected = !!conn
            const p = profiles.find(x => x.name === profileName)
            return (
              <>
                <button onClick={() => openEditForm(profileName)} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>
                  重新配置
                </button>
                {isConnected ? (
                  <button onClick={() => handleDisconnect(profileName)} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>
                    断开连接
                  </button>
                ) : (
                  <button onClick={() => { handleReconnect(profileName) }} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>
                    打开连接
                  </button>
                )}
                {isConnected && p?.type === 'mysql' && (
                  <button onClick={() => openDbFilter(profileName)} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>
                    选择显示的数据库
                  </button>
                )}
                <div className={`my-1 border-t ${border}`} />
                <button onClick={() => { setConfirmRemove(profileName); setContextMenu(null) }} className={`w-full text-left px-4 py-2 text-sm text-red-500 ${hover}`}>
                  移除连接
                </button>
              </>
            )
          })()}
        </div>
      )}

      {/* Confirm remove dialog */}
      {confirmRemove && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className={`${bg} rounded-lg w-80 border ${border} shadow-2xl p-6`}>
            <p className={`text-sm mb-4 ${dark ? 'text-gray-300' : 'text-gray-700'}`}>
              确定要移除连接「{confirmRemove}」吗？如已连接将同时断开。
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmRemove(null)} className={`px-4 py-1.5 rounded text-sm border ${dark ? 'border-[#3e3e42] hover:bg-[#3e3e42]' : 'border-gray-300 hover:bg-gray-100'}`}>取消</button>
              <button onClick={() => handleRemoveProfile(confirmRemove)} className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded text-sm">确认移除</button>
            </div>
          </div>
        </div>
      )}

      {/* DB visibility filter dialog */}
      {showDbFilter && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowDbFilter(null)}>
          <div className={`${bg} rounded-lg w-80 border ${border} shadow-2xl`} onClick={e => e.stopPropagation()}>
            <div className={`px-5 py-4 border-b ${border} flex justify-between items-center`}>
              <h3 className="font-semibold text-sm">选择显示的数据库</h3>
              <div className="flex items-center gap-2">
                <button onClick={() => saveVisibleDbs(showDbFilter.profileName, showDbFilter.connId, new Set(databases))} className="text-xs text-blue-500 hover:underline">全选</button>
                <button onClick={() => saveVisibleDbs(showDbFilter.profileName, showDbFilter.connId, new Set())} className="text-xs text-blue-500 hover:underline">全不选</button>
                <button onClick={() => setShowDbFilter(null)} className={`${dark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}>✕</button>
              </div>
            </div>
            <div className="p-4 max-h-80 overflow-y-auto">
              {databases.map(db => (
                <label key={db} className={`flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer ${hover}`}>
                  <input
                    type="checkbox"
                    checked={visibleDbs.has(db)}
                    onChange={() => {
                      const next = new Set(visibleDbs)
                      if (next.has(db)) next.delete(db); else next.add(db)
                      saveVisibleDbs(showDbFilter.profileName, showDbFilter.connId, next)
                    }}
                    className="w-4 h-4"
                  />
                  <span className="text-sm">{db}</span>
                </label>
              ))}
            </div>
            <div className="px-5 pb-4">
              <button onClick={() => setShowDbFilter(null)} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded text-sm">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* New / Edit connection form */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className={`${bg} rounded-lg w-96 border ${border} shadow-2xl`}>
            <div className={`px-5 py-4 border-b ${border} flex justify-between items-center`}>
              <h3 className="font-semibold">{editingProfile ? '编辑连接' : '新建连接'}</h3>
              <button onClick={() => { setShowForm(false); setEditingProfile(null) }} className={`${dark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}>✕</button>
            </div>
            <div className="p-5 space-y-3">
              <div className="flex gap-2">
                <button onClick={() => setType('mysql')} className={`flex-1 py-2 rounded text-sm border ${type === 'mysql' ? 'bg-blue-600 border-blue-600 text-white' : `bg-transparent ${border} ${hover}`}`}>
                  🐬 MySQL
                </button>
                <button onClick={() => setType('redis')} className={`flex-1 py-2 rounded text-sm border ${type === 'redis' ? 'bg-blue-600 border-blue-600 text-white' : `bg-transparent ${border} ${hover}`}`}>
                  🔴 Redis
                </button>
              </div>
              <div>
                <label className={`block text-xs mb-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>名称</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="我的连接" className={inputCls} />
              </div>
              <div className="grid grid-cols-5 gap-2">
                <div className="col-span-3">
                  <label className={`block text-xs mb-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>主机</label>
                  <input value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} className={inputCls} />
                </div>
                <div className="col-span-2">
                  <label className={`block text-xs mb-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>端口</label>
                  <input value={form.port} onChange={e => setForm({ ...form, port: e.target.value })} placeholder={type === 'mysql' ? '3306' : '6379'} className={inputCls} />
                </div>
              </div>
              {type === 'mysql' && (
                <div>
                  <label className={`block text-xs mb-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>用户名</label>
                  <input value={form.user} onChange={e => setForm({ ...form, user: e.target.value })} className={inputCls} />
                </div>
              )}
              <div>
                <label className={`block text-xs mb-1 ${dark ? 'text-gray-400' : 'text-gray-500'}`}>密码</label>
                <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} className={inputCls} />
              </div>
            </div>
            <div className="px-5 pb-5 flex gap-2">
              <button
                onClick={() => connect()}
                disabled={connecting !== null}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-2 rounded disabled:opacity-50 text-sm"
              >
                {connecting !== null ? '连接中...' : (editingProfile ? '保存并连接' : '连接')}
              </button>
              <button onClick={() => { setShowForm(false); setEditingProfile(null) }} className={`flex-1 py-2 rounded text-sm ${dark ? 'bg-[#3e3e42] hover:bg-[#4e4e52]' : 'bg-gray-200 hover:bg-gray-300'}`}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tree database filter modal */}
      {showTreeDbFilter && activeMysqlConn && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowTreeDbFilter(false)}>
          <div className={`${bg} rounded-lg w-80 border ${border} shadow-2xl`} onClick={e => e.stopPropagation()}>
            <div className={`px-5 py-4 border-b ${border} flex justify-between items-center`}>
              <h3 className="font-semibold text-sm">选择显示的数据库</h3>
              <div className="flex items-center gap-2">
                <button onClick={() => saveTreeVisibleDbs(activeMysqlConn, new Set(treeDatabases))} className="text-xs text-blue-500 hover:underline">全选</button>
                <button onClick={() => saveTreeVisibleDbs(activeMysqlConn, new Set())} className="text-xs text-blue-500 hover:underline">全不选</button>
                <button onClick={() => setShowTreeDbFilter(false)} className={`${dark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-900'}`}>✕</button>
              </div>
            </div>
            <div className="p-4 max-h-80 overflow-y-auto">
              {treeDatabases.map(db => (
                <label key={db} className={`flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer ${hover}`}>
                  <input
                    type="checkbox"
                    checked={treeVisibleDbs.has(db)}
                    onChange={() => {
                      const next = new Set(treeVisibleDbs)
                      if (next.has(db)) next.delete(db); else next.add(db)
                      saveTreeVisibleDbs(activeMysqlConn, next)
                    }}
                    className="w-4 h-4"
                  />
                  <span className="text-sm">{db}</span>
                </label>
              ))}
            </div>
            <div className="px-5 pb-4">
              <button onClick={() => setShowTreeDbFilter(false)} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded text-sm">确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
