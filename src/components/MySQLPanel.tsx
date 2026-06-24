import { useState, useEffect, useRef, useMemo, type Dispatch, type SetStateAction } from 'react'
import { EditorState, Compartment } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, placeholder, highlightSpecialChars, drawSelection, rectangularSelection, crosshairCursor, type BlockInfo } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { autocompletion, completionKeymap, type CompletionContext } from '@codemirror/autocomplete'
import { sql as sqlLanguage } from '@codemirror/lang-sql'
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { Connection, Theme } from '../App'
import { invoke } from '../ipc'
import haitunGreen from '../assets/haitun-2.png'

type Props = { connection: Connection; theme: Theme; requestedDb: string; requestedTable: string; requestedSeq?: number; onTabChange?: (db: string, table: string) => void; onSelectDb?: (db: string) => void }

type TableTabState = {
  data: any[]
  total: number
  page: number
  pageSize: number
  pageSizeText: string
  queryPage: number
  queryPageSize: number
  queryPageSizeText: string
  edits: Map<number, Record<string, any>>
  sortColumn: string
  sortOrder: SortOrder
  filters: Filter[]
  columnWidths: Record<string, number>
  allColumns: string[]
  activeTab: Tab
  structure: any[]
  ddl: string
  newRow: Record<string, any> | null
  logParserSql: string
  logParserParams: string
  logParserOutput: string
  logParserError: string
  jsonBeautifyInput: string
  jsonBeautifyOutput: string
  jsonBeautifyError: string
}
type Tab = 'data' | 'structure' | 'ddl' | 'query' | 'logParser' | 'jsonBeautify'
type SortOrder = 'ASC' | 'DESC' | null
type Filter = { column: string; op: string; value: string; logic?: 'AND' | 'OR'; group?: number; groupLogic?: 'AND' | 'OR'; enabled?: boolean }
type TabItem = { id: string; type: 'db' | 'table'; db: string; table?: string; label: string }
type VirtualScrollState = { scrollTop: number; clientHeight: number; direction: -1 | 0 | 1; speedRows: number }
type VirtualRange = { startIndex: number; endIndex: number; topPadding: number; bottomPadding: number }

const VIRTUAL_ROW_HEIGHT = 32
const VIRTUAL_OVERSCAN = 120
const VIRTUAL_FAST_OVERSCAN_MAX = 600
const PAGE_SIZE_OPTIONS = [200, 500, 1000, 2000]
const SQL_COMPLETION_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'SET', 'JOIN', 'LEFT JOIN', 'INNER JOIN', 'ON', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MAX', 'MIN', 'LIKE', 'IN', 'IS NULL', 'IS NOT NULL']
const sqlEditorTheme = new Compartment()
const sqlHighlightTheme = new Compartment()
const emptyVirtualScroll: VirtualScrollState = { scrollTop: 0, clientHeight: 0, direction: 0, speedRows: 0 }

const getVirtualRange = (rowCount: number, scroll: VirtualScrollState): VirtualRange => {
  if (rowCount <= 0) return { startIndex: 0, endIndex: 0, topPadding: 0, bottomPadding: 0 }
  const visibleCount = Math.ceil((scroll.clientHeight || VIRTUAL_ROW_HEIGHT * 20) / VIRTUAL_ROW_HEIGHT)
  const firstVisible = Math.min(rowCount - 1, Math.max(0, Math.floor(scroll.scrollTop / VIRTUAL_ROW_HEIGHT)))
  const fastOverscan = Math.min(VIRTUAL_FAST_OVERSCAN_MAX, scroll.speedRows * 2)
  const overscanBefore = VIRTUAL_OVERSCAN + (scroll.direction < 0 ? fastOverscan : 0)
  const overscanAfter = VIRTUAL_OVERSCAN + (scroll.direction > 0 ? fastOverscan : 0)
  const startIndex = Math.max(0, firstVisible - overscanBefore)
  const endIndex = Math.min(rowCount, firstVisible + visibleCount + overscanAfter)
  return {
    startIndex,
    endIndex,
    topPadding: startIndex * VIRTUAL_ROW_HEIGHT,
    bottomPadding: Math.max(0, (rowCount - endIndex) * VIRTUAL_ROW_HEIGHT),
  }
}

export default function MySQLPanel({ connection, theme, requestedDb, requestedTable, requestedSeq, onTabChange, onSelectDb }: Props) {
  const [tabs, setTabs] = useState<TabItem[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [tabContextMenu, setTabContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  // Per-tab state storage
  const tabStates = useRef<Map<string, TableTabState>>(new Map())

  const [selectedDb, setSelectedDb] = useState('')
  const [selectedTable, setSelectedTable] = useState('')
  const [activeTab, setActiveTab] = useState<Tab>('data')

  const [data, setData] = useState<any[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  const [pageSizeText, setPageSizeText] = useState('100')
  const [loading, setLoading] = useState(false)
  const [edits, setEdits] = useState<Map<number, Record<string, any>>>(new Map())
  const [sortColumn, setSortColumn] = useState<string>('')
  const [sortOrder, setSortOrder] = useState<SortOrder>(null)
  const [filters, setFilters] = useState<Filter[]>([{ column: '', op: '=', value: '', logic: 'AND' }])
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [allColumns, setAllColumns] = useState<string[]>([])
  // Multi-row selection
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  // Drag select state for row column
  const [rowDragStart, setRowDragStart] = useState<number | null>(null)
  const rowSelectionActive = useRef(false)
  // Drag select state for data column (col drag)
  const [colDragState, setColDragState] = useState<{ col: string; startRow: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null)
  const [headerContextMenu, setHeaderContextMenu] = useState<{ x: number; y: number; col: string; comment: string; isQuery: boolean } | null>(null)
  // New row state
  const [newRow, setNewRow] = useState<Record<string, any> | null>(null)
  const tableBodyRef = useRef<HTMLDivElement>(null)
  const queryTableBodyRef = useRef<HTMLDivElement>(null)
  const activeTabIdRef = useRef<string | null>(null)
  const savedScrollTop = useRef(0)
  const dataVirtualFrame = useRef<number | null>(null)
  const queryVirtualFrame = useRef<number | null>(null)
  const [dataVirtualScroll, setDataVirtualScroll] = useState<VirtualScrollState>(emptyVirtualScroll)
  const [queryVirtualScroll, setQueryVirtualScroll] = useState<VirtualScrollState>(emptyVirtualScroll)
  // Flag: true means the next effect trigger is from a user action (page/sort/filter change), not a tab switch
  const needsReload = useRef(false)
  // Flag: true means this is a first visit to the tab (no cached state), need initial load
  const needsInitialLoad = useRef(false)
  // Flag: true means structure hasn't been loaded for the current tab yet
  const needsStructureLoad = useRef(false)

  const [showExport, setShowExport] = useState(false)
  const [pageSizeMenuKey, setPageSizeMenuKey] = useState<string | null>(null)
  const exportRef = useRef<HTMLDivElement>(null)
  const [headerTooltip, setHeaderTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const [dbTabTables, setDbTabTables] = useState<{ db: string; list: string[] }[]>([])
  const [dbTabSearch, setDbTabSearch] = useState('')

  const [structure, setStructure] = useState<any[]>([])
  const [ddl, setDdl] = useState('')
  const [sql, setSql] = useState('')
  const sqlValueRef = useRef('')
  const [queryResult, setQueryResult] = useState<any>(null)
  const [queryResultData, setQueryResultData] = useState<any[]>([])
  const [queryResultTotal, setQueryResultTotal] = useState(0)
  const [queryPage, setQueryPage] = useState(1)
  const [queryPageSize, setQueryPageSize] = useState(100)
  const [queryPageSizeText, setQueryPageSizeText] = useState('100')
  const [queryAutoLimit, setQueryAutoLimit] = useState(false)
  const [queryEdits, setQueryEdits] = useState<Map<number, Record<string, any>>>(new Map())
  // Multi-row selection for query
  const [querySelectedRows, setQuerySelectedRows] = useState<Set<number>>(new Set())
  const [queryRowDragStart, setQueryRowDragStart] = useState<number | null>(null)
  const [queryColDragState, setQueryColDragState] = useState<{ col: string; startRow: number } | null>(null)
  const [queryContextMenu, setQueryContextMenu] = useState<{ x: number; y: number; rowIndex: number } | null>(null)
  const [queryNewRow, setQueryNewRow] = useState<Record<string, any> | null>(null)
  const [querySortColumn, setQuerySortColumn] = useState<string>('')
  const [querySortOrder, setQuerySortOrder] = useState<SortOrder>(null)
  const [queryColumnWidths, setQueryColumnWidths] = useState<Record<string, number>>({})
  const lastQuerySqlRef = useRef('')
  const [queryPanelHeight, setQueryPanelHeight] = useState(() => Math.floor((window.innerHeight - 120) / 2))
  const [logParserSql, setLogParserSql] = useState('')
  const [logParserParams, setLogParserParams] = useState('')
  const [logParserOutput, setLogParserOutput] = useState('')
  const [logParserError, setLogParserError] = useState('')
  const [jsonBeautifyInput, setJsonBeautifyInput] = useState('')
  const [jsonBeautifyOutput, setJsonBeautifyOutput] = useState('')
  const [jsonBeautifyError, setJsonBeautifyError] = useState('')
  const sqlCompletionSourcesRef = useRef<string[]>([])
  const [cellTooltip, setCellTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const cellTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [hoveredCell, setHoveredCell] = useState<{ row: number; col: string; isQuery: boolean } | null>(null)
  const sqlContainerRef = useRef<HTMLDivElement>(null)
  const sqlEditorRef = useRef<EditorView | null>(null)
  const runQueryRef = useRef<() => void>(() => {})

  const syncVirtualScroll = (el: HTMLDivElement | null, setter: Dispatch<SetStateAction<VirtualScrollState>>) => {
    if (!el) return
    setter(prev => {
      const scrollTop = el.scrollTop
      const clientHeight = el.clientHeight
      const deltaRows = Math.abs(scrollTop - prev.scrollTop) / VIRTUAL_ROW_HEIGHT
      const direction = scrollTop > prev.scrollTop ? 1 : scrollTop < prev.scrollTop ? -1 : prev.direction
      const speedRows = Math.round(deltaRows)
      if (prev.scrollTop === scrollTop && prev.clientHeight === clientHeight && prev.speedRows === speedRows && prev.direction === direction) return prev
      return { scrollTop, clientHeight, direction, speedRows }
    })
  }

  const handleVirtualScroll = (isQuery: boolean) => {
    const frameRef = isQuery ? queryVirtualFrame : dataVirtualFrame
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      syncVirtualScroll(isQuery ? queryTableBodyRef.current : tableBodyRef.current, isQuery ? setQueryVirtualScroll : setDataVirtualScroll)
    })
  }

  useEffect(() => {
    return () => {
      if (dataVirtualFrame.current !== null) cancelAnimationFrame(dataVirtualFrame.current)
      if (queryVirtualFrame.current !== null) cancelAnimationFrame(queryVirtualFrame.current)
    }
  }, [])

  useEffect(() => {
    syncVirtualScroll(tableBodyRef.current, setDataVirtualScroll)
  }, [data.length, activeTab])

  useEffect(() => {
    syncVirtualScroll(queryTableBodyRef.current, setQueryVirtualScroll)
  }, [queryResultData.length, activeTab, queryPanelHeight])

  useEffect(() => {
    if (tableBodyRef.current) {
      tableBodyRef.current.scrollTop = 0
      syncVirtualScroll(tableBodyRef.current, setDataVirtualScroll)
    }
  }, [page, pageSize, selectedTable])

  useEffect(() => {
    if (queryTableBodyRef.current) {
      queryTableBodyRef.current.scrollTop = 0
      syncVirtualScroll(queryTableBodyRef.current, setQueryVirtualScroll)
    }
  }, [queryPage, queryPageSize, queryResultData.length, queryResult])

  useEffect(() => {
    if (newRow !== null) setTimeout(() => syncVirtualScroll(tableBodyRef.current, setDataVirtualScroll), 0)
  }, [newRow])

  useEffect(() => {
    if (queryNewRow !== null) setTimeout(() => syncVirtualScroll(queryTableBodyRef.current, setQueryVirtualScroll), 0)
  }, [queryNewRow])

  useEffect(() => {
    if (!showExport) return
    const handler = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setShowExport(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showExport])

  // Delete confirm dialog
  const [deleteConfirm, setDeleteConfirm] = useState<{ rows: Set<number>; isQuery: boolean } | null>(null)

  // Toast notification
  const [toast, setToast] = useState<string | null>(null)
  const [tabTooltip, setTabTooltip] = useState<{ text: string; x: number; y: number } | null>(null)
  const tabTooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
  const [tabDropTarget, setTabDropTarget] = useState<{ id: string; side: 'before' | 'after' } | null>(null)
  const [ddlPreviewVisible, setDdlPreviewVisible] = useState(false)

  const showToast = (message: string) => {
    setToast(message)
    setTimeout(() => setToast(null), 2000)
  }

  const dark = theme === 'dark'
  const bg = dark ? 'bg-[#1e1e1e]' : 'bg-white'
  const bg2 = dark ? 'bg-[#252526]' : 'bg-gray-50'
  const border = dark ? 'border-[#3e3e42]' : 'border-gray-300'
  const text = dark ? 'text-white' : 'text-gray-900'
  const textSub = dark ? 'text-gray-400' : 'text-gray-500'
  const hover = dark ? 'hover:bg-[#2a2d2e]' : 'hover:bg-gray-100'
  const controlSurface = dark ? 'bg-[#2a2a2c]/90 hover:bg-[#343438]' : 'bg-white/90 hover:bg-gray-50'
  const appleControl = `rounded-xl shadow-sm transition-colors ${controlSurface}`
  const inputCls = `${bg} border ${border} rounded-xl px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 ${text}`

  useEffect(() => {
    if (!selectedTable) return
    // If triggered by a user action (page/sort/filter), always reload
    if (needsReload.current) {
      needsReload.current = false
      loadTableData()
    } else if (needsInitialLoad.current) {
      // First visit to this tab — load data
      needsInitialLoad.current = false
      loadTableData()
    }
    // Otherwise it's a tab switch with cached data — skip reload
  }, [selectedTable, page, pageSize, sortColumn, sortOrder])

  useEffect(() => {
    if (selectedTable && activeTab === 'structure' && structure.length === 0) loadTableStructure()
    if (selectedTable && activeTab === 'ddl' && !ddl) loadTableDDL()
    // Load structure for primary key info (needed by delete), but only on first visit
    if (selectedTable && needsStructureLoad.current) {
      needsStructureLoad.current = false
      loadTableStructure()
    }
  }, [selectedTable, activeTab])

  // Keep a ref to always-current state for use in callbacks
  const currentStateRef = useRef({ data, total, page, pageSize, pageSizeText, queryPage, queryPageSize, queryPageSizeText, edits, sortColumn, sortOrder, filters, columnWidths, allColumns, activeTab, structure, ddl, newRow, logParserSql, logParserParams, logParserOutput, logParserError, jsonBeautifyInput, jsonBeautifyOutput, jsonBeautifyError })
  useEffect(() => {
    currentStateRef.current = { data, total, page, pageSize, pageSizeText, queryPage, queryPageSize, queryPageSizeText, edits, sortColumn, sortOrder, filters, columnWidths, allColumns, activeTab, structure, ddl, newRow, logParserSql, logParserParams, logParserOutput, logParserError, jsonBeautifyInput, jsonBeautifyOutput, jsonBeautifyError }
  })

  // Save current table state before switching tabs
  const saveCurrentTabState = () => {
    const tabId = activeTabIdRef.current
    if (!tabId || !tabId.startsWith('table-')) return
    tabStates.current.set(tabId, { ...currentStateRef.current, sql: sqlEditorRef.current?.state.doc.toString() ?? sqlValueRef.current })
  }

  // Restore state for a tab, or reset to defaults if first visit
  const restoreTabState = (tabId: string) => {
    const saved = tabStates.current.get(tabId)
    if (saved) {
      setData(saved.data)
      setTotal(saved.total)
      setPage(saved.page)
      setPageSize(saved.pageSize)
      setPageSizeText(saved.pageSizeText ?? String(saved.pageSize))
      setQueryPage(saved.queryPage ?? 1)
      setQueryPageSize(saved.queryPageSize ?? 100)
      setQueryPageSizeText(saved.queryPageSizeText ?? String(saved.queryPageSize ?? 100))
      setEdits(saved.edits)
      setSortColumn(saved.sortColumn)
      setSortOrder(saved.sortOrder)
      setFilters(saved.filters)
      setColumnWidths(saved.columnWidths)
      setAllColumns(saved.allColumns)
      setActiveTab(saved.activeTab)
      setSql(saved.sql ?? '')
      sqlValueRef.current = saved.sql ?? ''
      setStructure(saved.structure)
      setDdl(saved.ddl)
      setNewRow(saved.newRow)
      setLogParserSql(saved.logParserSql)
      setLogParserParams(saved.logParserParams)
      setLogParserOutput(saved.logParserOutput)
      setLogParserError(saved.logParserError)
      setJsonBeautifyInput(saved.jsonBeautifyInput)
      setJsonBeautifyOutput(saved.jsonBeautifyOutput)
      setJsonBeautifyError(saved.jsonBeautifyError)
    } else {
      setData([])
      setTotal(0)
      setPage(1)
      setPageSize(100)
      setPageSizeText('100')
      setQueryPage(1)
      setQueryPageSize(100)
      setQueryPageSizeText('100')
      setEdits(new Map())
      setSortColumn('')
      setSortOrder(null)
      setFilters([{ column: '', op: '=', value: '', logic: 'AND' }])
      setColumnWidths({})
      setAllColumns([])
      setActiveTab('data')
      setSql('')
      sqlValueRef.current = ''
      setStructure([])
      setDdl('')
      setNewRow(null)
      setLogParserSql('')
      setLogParserParams('')
      setLogParserOutput('')
      setLogParserError('')
      setJsonBeautifyInput('')
      setJsonBeautifyOutput('')
      setJsonBeautifyError('')
      needsInitialLoad.current = true
      needsStructureLoad.current = true
    }
    setSelectedRows(new Set())
  }

  const switchToTab = (tabId: string, db: string, table: string) => {
    saveCurrentTabState()
    activeTabIdRef.current = tabId
    setActiveTabId(tabId)
    setSelectedDb(db)
    setSelectedTable(table)
    restoreTabState(tabId)
    onTabChange?.(db, table)
    setTimeout(() => {
      const tabEl = document.querySelector(`[data-tab-id="${tabId}"]`)
      if (tabEl) tabEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
      const sidebarItem = document.querySelector(`[data-sidebar-table="${db}::${table}"]`)
      if (sidebarItem) sidebarItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 50)
  }

  const openTableTab = (db: string, table: string) => {
    const tabId = `table-${connection.id}-${db}-${table}`
    if (!tabs.find(t => t.id === tabId)) {
      const newTab: TabItem = { id: tabId, type: 'table', db, table, label: table }
      setTabs(prev => [...prev, newTab])
    }
    switchToTab(tabId, db, table)
  }

  const openDbTab = async (db: string) => {
    const tabId = `db-${connection.id}-${db}`
    if (!tabs.find(t => t.id === tabId)) {
      const newTab: TabItem = { id: tabId, type: 'db', db, label: db }
      setTabs(prev => [...prev, newTab])
    }
    saveCurrentTabState()
    activeTabIdRef.current = tabId
    setActiveTabId(tabId)
    setTimeout(() => {
      const tabEl = document.querySelector(`[data-tab-id="${tabId}"]`)
      if (tabEl) tabEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    }, 50)
    if (!dbTabTables.find(t => t.db === db)) {
      const list = await invoke('mysql:tables', { id: connection.id, db })
      setDbTabTables(prev => [...prev, { db, list }])
    }
  }

  const closeTab = (tabId: string) => {
    tabStates.current.delete(tabId)
    setTabs(prev => prev.filter(t => t.id !== tabId))
    if (activeTabId === tabId) {
      const remaining = tabs.filter(t => t.id !== tabId)
      const nextTab = remaining.length > 0 ? remaining[remaining.length - 1] : null
      if (nextTab?.type === 'table' && nextTab.table) {
        switchToTab(nextTab.id, nextTab.db, nextTab.table)
      } else {
        activeTabIdRef.current = nextTab?.id ?? null
        setActiveTabId(nextTab?.id ?? null)
        setSelectedDb(nextTab?.db ?? '')
        setSelectedTable('')
        onTabChange?.(nextTab?.db ?? '', '')
      }
    }
  }

  const closeOtherTabs = (tabId: string) => {
    tabs.forEach(t => { if (t.id !== tabId) tabStates.current.delete(t.id) })
    setTabs(prev => prev.filter(t => t.id === tabId))
    setActiveTabId(tabId)
  }

  const closeAllTabs = () => {
    tabStates.current.clear()
    setTabs([])
    setActiveTabId(null)
    activeTabIdRef.current = null
    setSelectedDb('')
    setSelectedTable('')
    onTabChange?.('', '')
  }

  const reorderTabs = (fromId: string, toId: string, side: 'before' | 'after' = 'before') => {
    if (fromId === toId) return
    setTabs(prev => {
      const fromIndex = prev.findIndex(t => t.id === fromId)
      const toIndex = prev.findIndex(t => t.id === toId)
      if (fromIndex < 0 || toIndex < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      let insertIndex = next.findIndex(t => t.id === toId)
      if (insertIndex < 0) return prev
      if (side === 'after') insertIndex += 1
      next.splice(insertIndex, 0, moved)
      return next
    })
  }

  const selectTable = (db: string, table: string) => {
    openTableTab(db, table)
  }

  const lastHandledRequest = useRef('')

  // When Sidebar selects a table, open it as a tab
  useEffect(() => {
    const key = `${requestedSeq}::${requestedDb}::${requestedTable}`
    if (key === lastHandledRequest.current) return
    if (requestedDb && requestedTable) {
      lastHandledRequest.current = key
      openTableTab(requestedDb, requestedTable)
    } else if (requestedDb && !requestedTable) {
      lastHandledRequest.current = key
      openDbTab(requestedDb)
    }
  }, [requestedDb, requestedTable, requestedSeq])

  const loadTableData = async (overridePage?: number, overrideFilters?: Filter[]) => {
    setLoading(true)

    if (allColumns.length === 0) {
      const initRes = await invoke('mysql:query', {
        id: connection.id,
        sql: `SELECT * FROM \`${selectedDb}\`.\`${selectedTable}\` LIMIT 1`
      })
      if (initRes.success && initRes.data.length > 0) {
        setAllColumns(Object.keys(initRes.data[0]))
      }
    }

    let filterSQL = ''
    const allFilters = overrideFilters ?? filters
    const activeFilters = allFilters.filter(f => f.enabled !== false && f.column && (f.op === 'IS NULL' || f.op === 'IS NOT NULL' || f.op === 'IS EMPTY' || f.op === 'IS NOT EMPTY' || f.value))

    const buildCond = (f: Filter): string => {
      const col = `\`${f.column}\``
      const val = f.value.replace(/'/g, "''")
      if (f.op === '=') return `${col} = '${val}'`
      if (f.op === '!=') return `${col} != '${val}'`
      if (f.op === '<') return `${col} < '${val}'`
      if (f.op === '<=') return `${col} <= '${val}'`
      if (f.op === '>') return `${col} > '${val}'`
      if (f.op === '>=') return `${col} >= '${val}'`
      if (f.op === 'LIKE') return `${col} LIKE '%${val}%'`
      if (f.op === 'CONTAINS') return `${col} LIKE '%${val}%'`
      if (f.op === 'NOT CONTAINS') return `${col} NOT LIKE '%${val}%'`
      if (f.op === 'IS NULL') return `${col} IS NULL`
      if (f.op === 'IS NOT NULL') return `${col} IS NOT NULL`
      if (f.op === 'IS EMPTY') return `${col} = ''`
      if (f.op === 'IS NOT EMPTY') return `${col} != ''`
      if (f.op === 'BETWEEN') { const v = val.split(',').map(x => x.trim()); return `${col} BETWEEN '${v[0]}' AND '${v[1]}'` }
      if (f.op === 'NOT BETWEEN') { const v = val.split(',').map(x => x.trim()); return `${col} NOT BETWEEN '${v[0]}' AND '${v[1]}'` }
      if (f.op === 'IN') return `${col} IN (${val.split(',').map(v => `'${v.trim()}'`).join(',')})`
      if (f.op === 'NOT IN') return `${col} NOT IN (${val.split(',').map(v => `'${v.trim()}'`).join(',')})`
      return `${col} = '${val}'`
    }

    if (activeFilters.length > 0) {
      // Separate ungrouped and grouped filters, preserving original order
      // Build segments: each segment is either a single ungrouped filter or a group of filters with same group id
      type Segment = { type: 'single'; filter: Filter } | { type: 'group'; groupId: number; filters: Filter[] }
      const segments: Segment[] = []
      const seenGroups = new Set<number>()
      for (const f of activeFilters) {
        if (f.group === undefined) {
          segments.push({ type: 'single', filter: f })
        } else if (!seenGroups.has(f.group)) {
          seenGroups.add(f.group)
          const groupFilters = activeFilters.filter(x => x.group === f.group)
          segments.push({ type: 'group', groupId: f.group, filters: groupFilters })
        }
      }

      const parts: string[] = []
      segments.forEach((seg, si) => {
        const connector = si === 0 ? '' : ` ${seg.type === 'group' ? (seg.filters[0]?.logic ?? 'AND') : (seg.filter.logic ?? 'AND')} `
        if (seg.type === 'single') {
          parts.push(connector + buildCond(seg.filter))
        } else {
          const inner = seg.filters.map((f, fi) => (fi === 0 ? '' : ` ${f.logic ?? 'AND'} `) + buildCond(f)).join('')
          parts.push(connector + `(${inner})`)
        }
      })
      filterSQL = ' WHERE ' + parts.join('')
    }
    let orderSQL = ''
    if (sortColumn && sortOrder) {
      orderSQL = ` ORDER BY \`${sortColumn}\` ${sortOrder}`
    }

    const safePage = (Number.isFinite(overridePage ?? page) ? (overridePage ?? page) : 1)
    const safePageSize = (Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 100)
    const res = await invoke('mysql:query', {
      id: connection.id,
      sql: `SELECT * FROM \`${selectedDb}\`.\`${selectedTable}\`${filterSQL}${orderSQL} LIMIT ${safePageSize} OFFSET ${(safePage - 1) * safePageSize}`
    })
    const countRes = await invoke('mysql:query', {
      id: connection.id,
      sql: `SELECT COUNT(*) as total FROM \`${selectedDb}\`.\`${selectedTable}\`${filterSQL}`
    })
    if (res.success) {
      setData(res.data)
      setTotal(Number(countRes.data[0]?.total) || 0)
    } else {
      alert('查询失败: ' + res.error)
    }
    setLoading(false)
  }

  const loadTableStructure = async () => {
    const res = await invoke('mysql:tableStructure', { id: connection.id, db: selectedDb, table: selectedTable })
    if (res.success) setStructure(res.data)
  }

  const loadTableDDL = async () => {
    const res = await invoke('mysql:tableDDL', { id: connection.id, db: selectedDb, table: selectedTable })
    if (res.success) setDdl(res.ddl)
  }

  const ensureTableDDL = async () => {
    if (ddl || !selectedDb || !selectedTable) return
    const res = await invoke('mysql:tableDDL', { id: connection.id, db: selectedDb, table: selectedTable })
    if (res.success) setDdl(res.ddl)
  }

  const copyCurrentDDL = () => {
    if (!ddl) return
    navigator.clipboard.writeText(ddl)
    showToast('DDL 已复制')
  }

  const handleCellEdit = (rowIndex: number, column: string, value: any) => {
    const newEdits = new Map(edits)
    if (!newEdits.has(rowIndex)) newEdits.set(rowIndex, {})
    newEdits.get(rowIndex)![column] = value
    setEdits(newEdits)
  }

  const submitEdits = async () => {
    // Handle new row insert — always refresh after success
    if (newRow !== null) {
      const cols = columns.filter(c => newRow[c] !== undefined && newRow[c] !== '')
      if (cols.length > 0) {
        const insertSQL = `INSERT INTO \`${selectedDb}\`.\`${selectedTable}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(c => `'${String(newRow[c]).replace(/'/g, "''")}'`).join(', ')})`
        const res = await invoke('mysql:query', { id: connection.id, sql: insertSQL })
        if (!res.success) { alert(`新增失败: ${res.error}`); return }
      }
      setNewRow(null)
      // Flush any pending edits too
      const primaryKey = data[0] ? Object.keys(data[0])[0] : 'id'
      for (const [rowIndex, updates] of edits.entries()) {
        const row = data[rowIndex]
        const res = await invoke('mysql:updateRow', {
          id: connection.id, db: selectedDb, table: selectedTable, primaryKey, pkValue: row[primaryKey], updates
        })
        if (!res.success) { alert(`更新失败: ${res.error}`); return }
      }
      setEdits(new Map())
      setPage(1)
      await loadTableData(1)
      return
    }
    // Handle edits only — apply locally without re-fetching
    const primaryKey = data[0] ? Object.keys(data[0])[0] : 'id'
    for (const [rowIndex, updates] of edits.entries()) {
      const row = data[rowIndex]
      const res = await invoke('mysql:updateRow', {
        id: connection.id, db: selectedDb, table: selectedTable, primaryKey, pkValue: row[primaryKey], updates
      })
      if (!res.success) { alert(`更新失败: ${res.error}`); return }
    }
    setData(prev => prev.map((row, i) => edits.has(i) ? { ...row, ...edits.get(i) } : row))
    setEdits(new Map())
  }

  const discardEdits = () => {
    setEdits(new Map())
    setNewRow(null)
  }

  const addNewRow = () => {
    const emptyRow: Record<string, any> = {}
    columns.forEach(c => { emptyRow[c] = '' })
    setNewRow(emptyRow)
    // Scroll table to bottom
    setTimeout(() => {
      if (tableBodyRef.current) {
        tableBodyRef.current.scrollTop = tableBodyRef.current.scrollHeight
      }
    }, 50)
  }

  const normalizeSqlForExecute = (sqlText: string) => sqlText.trim().replace(/;+\s*$/, '')

  const getSelectedSqlText = () => {
    const view = sqlEditorRef.current
    if (!view) return ''
    const selection = view.state.selection.main
    if (selection.empty) return ''
    return view.state.sliceDoc(selection.from, selection.to)
  }

  const setSqlSelectionRange = (start: number, end: number) => {
    const view = sqlEditorRef.current
    if (!view) return
    const docLength = view.state.doc.length
    const safeStart = Math.max(0, Math.min(start, docLength))
    const safeEnd = Math.max(0, Math.min(end, docLength))
    view.dispatch({ selection: { anchor: safeStart, head: safeEnd }, scrollIntoView: true })
    view.focus()
  }

  const createSqlEditorTheme = (darkMode: boolean, height: number) => EditorView.theme({
    '&': {
      height: `${height}px`,
      fontSize: '14px',
      backgroundColor: darkMode ? '#1e1e1e' : '#ffffff',
      color: darkMode ? '#d4d4d4' : '#1e1e1e',
    },
    '.cm-editor': { height: '100%' },
    '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
    '.cm-content': { padding: '12px 0', caretColor: darkMode ? '#ffffff' : '#333' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: darkMode ? '#ffffff' : '#333' },
    '&.cm-focused .cm-cursor': { borderLeftColor: darkMode ? '#ffffff' : '#333' },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': {
      backgroundColor: darkMode ? '#252526' : '#f9fafb',
      color: darkMode ? '#9ca3af' : '#6b7280',
      borderRight: `1px solid ${darkMode ? '#3e3e42' : '#d1d5db'}`,
      cursor: 'default',
    },
    '.cm-lineNumbers': { minWidth: '36px' },
    '.cm-lineNumbers .cm-gutterElement': {
      minWidth: '28px',
      padding: '0 6px',
      cursor: 'pointer',
      userSelect: 'none',
    },
    '.cm-activeLineGutter': { backgroundColor: darkMode ? '#2a2d2e' : '#eef2ff' },
    '.cm-activeLine': { backgroundColor: darkMode ? '#252526' : '#f8fafc' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: darkMode ? '#264f78' : '#bfdbfe' },
    '.cm-tooltip': {
      border: `1px solid ${darkMode ? 'rgba(75,85,99,0.9)' : 'rgba(209,213,219,0.9)'}`,
      borderRadius: '14px',
      overflow: 'hidden',
      boxShadow: darkMode ? '0 18px 40px rgba(0,0,0,0.45)' : '0 18px 40px rgba(15,23,42,0.16)',
      backdropFilter: 'blur(12px)',
      backgroundColor: darkMode ? 'rgba(37,37,38,0.88)' : 'rgba(255,255,255,0.88)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      padding: '6px',
      maxHeight: '260px',
      backgroundColor: 'transparent',
    },
    '.cm-tooltip-autocomplete ul li': {
      borderRadius: '10px',
      padding: '6px 10px',
      color: darkMode ? '#e5e7eb' : '#111827',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: darkMode ? 'rgba(37,99,235,0.85)' : 'rgba(59,130,246,0.16)',
      color: darkMode ? '#ffffff' : '#1d4ed8',
    },
    '&.cm-focused': { outline: 'none' },
  })

  const createSqlHighlightStyle = (darkMode: boolean) => HighlightStyle.define([
    { tag: t.keyword, color: darkMode ? '#569cd6' : '#0000cc' },
    { tag: t.number, color: darkMode ? '#b5cea8' : '#098658' },
    { tag: t.string, color: darkMode ? '#ce9178' : '#a31515' },
    { tag: t.comment, color: '#6a9955' },
    { tag: t.operator, color: darkMode ? '#d4d4d4' : '#1e1e1e' },
    { tag: t.variableName, color: darkMode ? '#9cdcfe' : '#001080' },
  ])

  const completeSql = (context: CompletionContext) => {
    const word = context.matchBefore(/[\w.]+/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    return {
      from: word.from,
      options: sqlCompletionSourcesRef.current.map(label => ({ label, type: /^[A-Z\s]+$/.test(label) ? 'keyword' : 'variable' })),
    }
  }

  const selectSqlStatementAt = (pos: number) => {
    const view = sqlEditorRef.current
    if (!view) return
    const doc = view.state.doc
    const text = doc.toString()
    const currentLine = doc.lineAt(pos)

    let blockStartLine = currentLine.number
    while (blockStartLine > 1 && doc.line(blockStartLine - 1).text.trim() !== '') blockStartLine--

    let blockEndLine = currentLine.number
    while (blockEndLine < doc.lines && doc.line(blockEndLine + 1).text.trim() !== '') blockEndLine++

    const blockStart = doc.line(blockStartLine).from
    const blockEnd = doc.line(blockEndLine).to
    const scopedText = text.slice(blockStart, blockEnd)
    const scopedPos = Math.max(0, Math.min(pos - blockStart, scopedText.length))

    const prevSemicolon = scopedText.lastIndexOf(';', Math.max(0, scopedPos - 1))
    const nextSemicolon = scopedText.indexOf(';', scopedPos)
    let start = blockStart + (prevSemicolon >= 0 ? prevSemicolon + 1 : 0)
    let end = blockStart + (nextSemicolon >= 0 ? nextSemicolon + 1 : scopedText.length)

    while (start < end && /\s/.test(text[start])) start++
    if (nextSemicolon < 0) {
      while (end > start && /\s/.test(text[end - 1])) end--
    }
    view.dispatch({ selection: { anchor: start, head: end }, scrollIntoView: true })
    view.focus()
  }

  const createSqlEditorExtensions = (darkMode: boolean, height: number) => [
    lineNumbers({
      domEventHandlers: {
        mousedown(view: EditorView, line: BlockInfo, event: MouseEvent) {
          event.preventDefault()
          selectSqlStatementAt(line.from)
          return true
        }
      }
    }),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    EditorView.lineWrapping,
    indentOnInput(),
    bracketMatching(),
    sqlLanguage(),
    autocompletion({ override: [completeSql] }),
    keymap.of([
      { key: 'Mod-Enter', run: () => { runQueryRef.current(); return true } },
      ...defaultKeymap,
      ...historyKeymap,
      ...completionKeymap,
    ]),
    EditorView.updateListener.of(update => {
      if (update.docChanged) sqlValueRef.current = update.state.doc.toString()
    }),
    sqlEditorTheme.of(createSqlEditorTheme(darkMode, height)),
    sqlHighlightTheme.of(syntaxHighlighting(createSqlHighlightStyle(darkMode))),
    placeholder('输入 SQL 语句...'),
  ]

  useEffect(() => {
    if (activeTab !== 'query' || !sqlContainerRef.current || sqlEditorRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: sqlValueRef.current || sql,
        extensions: createSqlEditorExtensions(dark, queryPanelHeight),
      }),
      parent: sqlContainerRef.current,
    })
    sqlEditorRef.current = view
    return () => {
      view.destroy()
      sqlEditorRef.current = null
    }
  }, [activeTab])

  useEffect(() => {
    const view = sqlEditorRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === sql) return
    sqlValueRef.current = sql
    view.dispatch({ changes: { from: 0, to: current.length, insert: sql } })
  }, [sql])

  useEffect(() => {
    const view = sqlEditorRef.current
    if (!view) return
    view.dispatch({
      effects: [
        sqlEditorTheme.reconfigure(createSqlEditorTheme(dark, queryPanelHeight)),
        sqlHighlightTheme.reconfigure(syntaxHighlighting(createSqlHighlightStyle(dark))),
      ]
    })
  }, [dark, queryPanelHeight])

  const deleteSelectedRows = async (rowsSet: Set<number>, isQuery: boolean) => {
    const targetData = isQuery ? queryResultData : data
    // Use PRI key from structure if available, else fall back to first column
    const priCol = structure.find(c => c.Key === 'PRI')?.Field
    const primaryKey = priCol || (targetData[0] ? Object.keys(targetData[0])[0] : 'id')
    const db = selectedDb
    const tbl = selectedTable
    for (const rowIndex of rowsSet) {
      const row = targetData[rowIndex]
      if (!row) continue
      if (row[primaryKey] === undefined || row[primaryKey] === null) {
        alert('无法删除：找不到主键列 ' + primaryKey); return
      }
      const res = await invoke('mysql:query', {
        id: connection.id,
        sql: `DELETE FROM \`${db}\`.\`${tbl}\` WHERE \`${primaryKey}\` = '${String(row[primaryKey]).replace(/'/g, "''")}'`
      })
      if (!res.success) { alert(`删除失败: ${res.error}`); return }
    }
    if (isQuery) {
      setQuerySelectedRows(new Set())
      executeQuery()
    } else {
      setSelectedRows(new Set())
      loadTableData()
    }
    setDeleteConfirm(null)
  }

  const executeQuery = async (keepPage = false, overrideSql?: string) => {
    const currentSql = sqlEditorRef.current?.state.doc.toString() ?? sqlValueRef.current
    const selectedText = overrideSql ? '' : getSelectedSqlText()
    let sqlToRun = normalizeSqlForExecute(overrideSql ?? (selectedText || currentSql))
    if (selectedDb) {
      sqlToRun = sqlToRun.replace(
        /\b(FROM|JOIN|UPDATE|INTO)\s+`?([A-Za-z0-9_]+)`?(?![A-Za-z0-9_.])/gi,
        (_, kw, tbl) => `${kw} \`${selectedDb}\`.\`${tbl}\``
      )
    }

    // Auto-limit: if it's a SELECT without LIMIT, add LIMIT + OFFSET for server-side paging
    const isSelect = /^\s*SELECT\b/i.test(sqlToRun)
    const hasLimit = /\bLIMIT\b/i.test(sqlToRun)
    const autoLimit = isSelect && !hasLimit
    lastQuerySqlRef.current = sqlToRun

    const page = keepPage ? queryPage : 1
    if (!keepPage) setQueryPage(1)
    setQueryAutoLimit(autoLimit)
    setLoading(true)

    const structurePromise = selectedTable
      ? invoke('mysql:tableStructure', { id: connection.id, db: selectedDb, table: selectedTable })
      : Promise.resolve(null)

    if (autoLimit) {
      const offset = (page - 1) * queryPageSize
      const pagedSQL = `${sqlToRun.trimEnd()} LIMIT ${queryPageSize} OFFSET ${offset}`
      // Count total using subquery
      const countSQL = `SELECT COUNT(*) AS __count FROM (${sqlToRun}) AS __t`
      const [res, countRes, structRes] = await Promise.all([
        invoke('mysql:query', { id: connection.id, sql: pagedSQL }),
        invoke('mysql:query', { id: connection.id, sql: countSQL }),
        structurePromise
      ])
      if (structRes?.success) setStructure(structRes.data)
      setQueryResult(res)
      if (res.success && Array.isArray(res.data)) {
        setQueryResultData(res.data)
        const total = countRes?.success && countRes.data?.[0]?.__count != null
          ? Number(countRes.data[0].__count)
          : res.data.length
        setQueryResultTotal(total)
      }
    } else {
      const [res, structRes] = await Promise.all([
        invoke('mysql:query', { id: connection.id, sql: sqlToRun }),
        structurePromise
      ])
      if (structRes?.success) setStructure(structRes.data)
      setQueryResult(res)
      if (res.success && Array.isArray(res.data)) {
        setQueryResultTotal(res.data.length)
        if (keepPage) {
          const start = (page - 1) * queryPageSize
          setQueryResultData(res.data.slice(start, start + queryPageSize))
        } else {
          setQueryResultData(res.data.slice(0, queryPageSize))
        }
      }
    }
    setLoading(false)
  }

  const executeQueryWithPage = async (targetPage: number) => {
    const currentSql = sqlEditorRef.current?.state.doc.toString() ?? sqlValueRef.current
    const selectedText = getSelectedSqlText()
    let sqlToRun = normalizeSqlForExecute(selectedText || currentSql)
    if (selectedDb) {
      sqlToRun = sqlToRun.replace(
        /\b(FROM|JOIN|UPDATE|INTO)\s+`?([A-Za-z0-9_]+)`?(?![A-Za-z0-9_.])/gi,
        (_, kw, tbl) => `${kw} \`${selectedDb}\`.\`${tbl}\``
      )
    }
    lastQuerySqlRef.current = sqlToRun
    const offset = (targetPage - 1) * queryPageSize
    const pagedSQL = `${sqlToRun.trimEnd()} LIMIT ${queryPageSize} OFFSET ${offset}`
    setLoading(true)
    const res = await invoke('mysql:query', { id: connection.id, sql: pagedSQL })
    setQueryResult(res)
    if (res.success && Array.isArray(res.data)) {
      setQueryResultData(res.data)
    }
    setLoading(false)
  }

  runQueryRef.current = () => executeQuery()

  useEffect(() => {
    if (queryAutoLimit) return
    if (queryResult?.success && Array.isArray(queryResult.data)) {
      let sorted = [...queryResult.data]
      if (querySortColumn && querySortOrder) {
        sorted.sort((a, b) => {
          const aVal = a[querySortColumn]
          const bVal = b[querySortColumn]
          if (aVal === null) return querySortOrder === 'ASC' ? 1 : -1
          if (bVal === null) return querySortOrder === 'ASC' ? -1 : 1
          const cmp = aVal > bVal ? 1 : aVal < bVal ? -1 : 0
          return querySortOrder === 'ASC' ? cmp : -cmp
        })
      }
      const start = (queryPage - 1) * queryPageSize
      setQueryResultData(sorted.slice(start, start + queryPageSize))
      setQueryResultTotal(sorted.length)
    }
  }, [queryPage, queryPageSize, queryResult, querySortColumn, querySortOrder, queryAutoLimit])

  const handleQueryCellEdit = (rowIndex: number, column: string, value: any) => {
    const newEdits = new Map(queryEdits)
    if (!newEdits.has(rowIndex)) newEdits.set(rowIndex, {})
    newEdits.get(rowIndex)![column] = value
    setQueryEdits(newEdits)
  }

  const submitQueryEdits = async () => {
    // Handle new row insert for query — re-execute query after success
    if (queryNewRow !== null) {
      const queryCols = queryResultData[0] ? Object.keys(queryResultData[0]) : []
      const cols = queryCols.filter(c => queryNewRow[c] !== undefined && queryNewRow[c] !== '')
      if (cols.length > 0 && selectedDb && selectedTable) {
        const insertSQL = `INSERT INTO \`${selectedDb}\`.\`${selectedTable}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(c => `'${String(queryNewRow[c]).replace(/'/g, "''")}'`).join(', ')})`
        const res = await invoke('mysql:query', { id: connection.id, sql: insertSQL })
        if (!res.success) { alert(`新增失败: ${res.error}`); return }
      }
      setQueryNewRow(null)
      // Also flush any pending edits before refreshing
      if (queryEdits.size > 0) {
        const cols2 = queryResultData[0] ? Object.keys(queryResultData[0]) : []
        if (!cols2.includes('id') || !selectedDb || !selectedTable) { setQueryEdits(new Map()); executeQuery(); return }
        for (const [rowIndex, updates] of queryEdits.entries()) {
          const row = queryResultData[rowIndex]
          const res = await invoke('mysql:updateRow', {
            id: connection.id, db: selectedDb, table: selectedTable, primaryKey: 'id', pkValue: row.id, updates
          })
          if (!res.success) { alert(`更新失败: ${res.error}`); return }
        }
        setQueryEdits(new Map())
      }
      executeQuery()
      return
    }
    // Handle edits only — apply locally without re-executing
    const cols = queryResultData[0] ? Object.keys(queryResultData[0]) : []
    if (!cols.includes('id')) { alert('查询结果无 id 字段，无法更新'); return }
    if (!selectedDb || !selectedTable) { alert('无法确定更新的表，请在数据页面修改'); return }
    for (const [rowIndex, updates] of queryEdits.entries()) {
      const row = queryResultData[rowIndex]
      const res = await invoke('mysql:updateRow', {
        id: connection.id, db: selectedDb, table: selectedTable, primaryKey: 'id', pkValue: row.id, updates
      })
      if (!res.success) { alert(`更新失败: ${res.error}`); return }
    }
    setQueryResultData(prev => prev.map((row, i) => queryEdits.has(i) ? { ...row, ...queryEdits.get(i) } : row))
    setQueryEdits(new Map())
  }

  const discardQueryEdits = () => {
    setQueryEdits(new Map())
    setQueryNewRow(null)
  }

  const addQueryNewRow = () => {
    const queryCols = queryResultData[0] ? Object.keys(queryResultData[0]) : []
    const emptyRow: Record<string, any> = {}
    queryCols.forEach(c => { emptyRow[c] = '' })
    setQueryNewRow(emptyRow)
  }

  const handleQuerySort = (col: string) => {
    if (querySortColumn === col) {
      setQuerySortOrder(querySortOrder === 'ASC' ? 'DESC' : querySortOrder === 'DESC' ? null : 'ASC')
      if (querySortOrder === 'DESC') setQuerySortColumn('')
    } else {
      setQuerySortColumn(col)
      setQuerySortOrder('ASC')
    }
  }

  const copyQueryRowSQL = (rowIndex: number) => {
    const row = queryResultData[rowIndex]
    if (!row) return
    const cols = Object.keys(row)
    const tableName = selectedTable || 'table'
    const sqlStr = `INSERT INTO \`${tableName}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(c => row[c] === null ? 'NULL' : formatDateForSQL(row[c])).join(', ')});`
    navigator.clipboard.writeText(sqlStr)
    setQueryContextMenu(null)
    showToast('插入 SQL 已复制')
  }

  const copyQueryRowUpdateSQL = (rowIndex: number) => {
    const row = queryResultData[rowIndex]
    if (!row) return
    const cols = Object.keys(row)
    const idCol = cols.find(c => c.toLowerCase() === 'id') || cols[0]
    const otherCols = cols.filter(c => c !== idCol)
    const tableName = selectedTable || 'table'
    const setClause = otherCols.map(c => `\`${c}\` = ${row[c] === null ? 'NULL' : formatDateForSQL(row[c])}`).join(', ')
    const sqlStr = `UPDATE \`${tableName}\` SET ${setClause} WHERE \`${idCol}\` = ${formatDateForSQL(row[idCol])};`
    navigator.clipboard.writeText(sqlStr)
    setQueryContextMenu(null)
    showToast('更新 SQL 已复制')
  }

  const copyQueryRowJSON = (rowIndex: number) => {
    const row = queryResultData[rowIndex]
    if (!row) return
    const formatted = Object.fromEntries(Object.entries(row).map(([k, v]) => {
      if (v instanceof Date || (typeof v === 'string' && (/^\d{4}-\d{2}-\d{2}T/.test(v) || /^[A-Z][a-z]{2}\s[A-Z][a-z]{2}/.test(v)))) {
        const d = new Date(v as any)
        if (!isNaN(d.getTime())) {
          const pad = (n: number) => String(n).padStart(2, '0')
          return [k, `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`]
        }
      }
      return [k, v]
    }))
    navigator.clipboard.writeText(JSON.stringify(formatted, null, 2))
    setQueryContextMenu(null)
    showToast('JSON 已复制')
  }

  const isIdColumn = (col: string) => col.toLowerCase() === 'id'
  const getColumnMinWidth = (col: string) => isIdColumn(col) ? 66 : 146
  const getColumnDefaultMaxWidth = (col: string) => isIdColumn(col) ? 160 : 200

  const getDefaultColumnWidth = (col: string, rows: any[]) => {
    const values = rows.slice(0, 100).map(row => formatValue(row?.[col]))
    const maxLen = Math.max(col.length, ...values.map(v => v.length))
    const minWidth = getColumnMinWidth(col)
    const contentWidth = Math.ceil(maxLen * 8 + 24)
    return Math.min(getColumnDefaultMaxWidth(col), Math.max(minWidth, contentWidth))
  }

  const getDataColumnWidth = (col: string) => columnWidths[col] || getDefaultColumnWidth(col, data)
  const getQueryColumnWidth = (col: string) => queryColumnWidths[col] || getDefaultColumnWidth(col, queryResultData)

  const startQueryResize = (col: string, e: React.MouseEvent) => {
    const startX = e.clientX
    const startWidth = getQueryColumnWidth(col)
    const onMove = (ev: MouseEvent) => setQueryColumnWidths(prev => ({ ...prev, [col]: Math.max(getColumnMinWidth(col), startWidth + ev.clientX - startX) }))
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleSort = (col: string) => {
    needsReload.current = true
    if (sortColumn === col) {
      setSortOrder(sortOrder === 'DESC' ? 'ASC' : sortOrder === 'ASC' ? null : 'DESC')
      if (sortOrder === 'ASC') setSortColumn('')
    } else {
      setSortColumn(col)
      setSortOrder('DESC')
    }
    setPage(1)
  }

  const applyFilters = () => {
    needsReload.current = true
    setPage(1)
    loadTableData()
  }

  const formatDateForSQL = (v: any): string => {
    if (v === null || v === undefined) return 'NULL'
    const tryDate = (val: any) => {
      const d = new Date(val)
      if (isNaN(d.getTime())) return null
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }
    if (v instanceof Date) return `'${tryDate(v) ?? v}'`
    if (typeof v === 'string' && (/^\d{4}-\d{2}-\d{2}T/.test(v) || /^[A-Z][a-z]{2}\s[A-Z][a-z]{2}/.test(v))) {
      const formatted = tryDate(v)
      if (formatted) return `'${formatted}'`
    }
    return `'${String(v).replace(/'/g, "\\'")}'`
  }

  const copyRowSQL = (rowIndex: number) => {
    const row = data[rowIndex]
    if (!row) return
    const cols = Object.keys(row)
    const sqlStr = `INSERT INTO \`${selectedTable}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(c => row[c] === null ? 'NULL' : formatDateForSQL(row[c])).join(', ')});`
    navigator.clipboard.writeText(sqlStr)
    setContextMenu(null)
    showToast('插入 SQL 已复制')
  }

  const copyRowUpdateSQL = (rowIndex: number) => {
    const row = data[rowIndex]
    if (!row) return
    const cols = Object.keys(row)
    const idCol = cols.find(c => c.toLowerCase() === 'id') || cols[0]
    const otherCols = cols.filter(c => c !== idCol)
    const setClause = otherCols.map(c => `\`${c}\` = ${row[c] === null ? 'NULL' : formatDateForSQL(row[c])}`).join(', ')
    const sqlStr = `UPDATE \`${selectedTable}\` SET ${setClause} WHERE \`${idCol}\` = ${formatDateForSQL(row[idCol])};`
    navigator.clipboard.writeText(sqlStr)
    setContextMenu(null)
    showToast('更新 SQL 已复制')
  }

  const copyRowJSON = (rowIndex: number) => {
    const row = data[rowIndex]
    if (!row) return
    const formatted = Object.fromEntries(Object.entries(row).map(([k, v]) => {
      if (v instanceof Date || (typeof v === 'string' && (/^\d{4}-\d{2}-\d{2}T/.test(v) || /^[A-Z][a-z]{2}\s[A-Z][a-z]{2}/.test(v)))) {
        const d = new Date(v as any)
        if (!isNaN(d.getTime())) {
          const pad = (n: number) => String(n).padStart(2, '0')
          return [k, `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`]
        }
      }
      return [k, v]
    }))
    navigator.clipboard.writeText(JSON.stringify(formatted, null, 2))
    setContextMenu(null)
    showToast('JSON 已复制')
  }

  const getQueryExportRows = async () => {
    if (!queryResult?.success || !Array.isArray(queryResult.data) || queryResult.data.length === 0) return []
    if (!queryAutoLimit) return queryResult.data
    const sqlToRun = lastQuerySqlRef.current || sqlEditorRef.current?.state.doc.toString() || sqlValueRef.current
    if (!sqlToRun.trim()) return queryResultData
    const res = await invoke('mysql:query', { id: connection.id, sql: sqlToRun })
    if (!res.success) throw new Error(res.error || '查询失败')
    return Array.isArray(res.data) ? res.data : []
  }

  const escapeXml = (value: any) => formatValue(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

  const columnLetter = (index: number) => {
    let n = index + 1
    let result = ''
    while (n > 0) {
      const rem = (n - 1) % 26
      result = String.fromCharCode(65 + rem) + result
      n = Math.floor((n - 1) / 26)
    }
    return result
  }

  const crc32 = (bytes: Uint8Array) => {
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  const createZipBlob = (files: { name: string; content: string }[], mimeType: string) => {
    const encoder = new TextEncoder()
    const parts: Uint8Array[] = []
    const centralParts: Uint8Array[] = []
    let offset = 0

    const writeHeader = (size: number, fill: (view: DataView) => void) => {
      const buffer = new ArrayBuffer(size)
      const view = new DataView(buffer)
      fill(view)
      return new Uint8Array(buffer)
    }

    files.forEach(file => {
      const nameBytes = encoder.encode(file.name)
      const contentBytes = encoder.encode(file.content)
      const crc = crc32(contentBytes)
      const localOffset = offset
      const localHeader = writeHeader(30, view => {
        view.setUint32(0, 0x04034b50, true)
        view.setUint16(4, 20, true)
        view.setUint16(6, 0, true)
        view.setUint16(8, 0, true)
        view.setUint16(10, 0, true)
        view.setUint16(12, 0, true)
        view.setUint32(14, crc, true)
        view.setUint32(18, contentBytes.length, true)
        view.setUint32(22, contentBytes.length, true)
        view.setUint16(26, nameBytes.length, true)
        view.setUint16(28, 0, true)
      })
      parts.push(localHeader, nameBytes, contentBytes)
      offset += localHeader.length + nameBytes.length + contentBytes.length

      const centralHeader = writeHeader(46, view => {
        view.setUint32(0, 0x02014b50, true)
        view.setUint16(4, 20, true)
        view.setUint16(6, 20, true)
        view.setUint16(8, 0, true)
        view.setUint16(10, 0, true)
        view.setUint16(12, 0, true)
        view.setUint16(14, 0, true)
        view.setUint32(16, crc, true)
        view.setUint32(20, contentBytes.length, true)
        view.setUint32(24, contentBytes.length, true)
        view.setUint16(28, nameBytes.length, true)
        view.setUint16(30, 0, true)
        view.setUint16(32, 0, true)
        view.setUint16(34, 0, true)
        view.setUint16(36, 0, true)
        view.setUint32(38, 0, true)
        view.setUint32(42, localOffset, true)
      })
      centralParts.push(centralHeader, nameBytes)
    })

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
    const centralOffset = offset
    const endHeader = writeHeader(22, view => {
      view.setUint32(0, 0x06054b50, true)
      view.setUint16(4, 0, true)
      view.setUint16(6, 0, true)
      view.setUint16(8, files.length, true)
      view.setUint16(10, files.length, true)
      view.setUint32(12, centralSize, true)
      view.setUint32(16, centralOffset, true)
      view.setUint16(20, 0, true)
    })

    return new Blob([...parts, ...centralParts, endHeader], { type: mimeType })
  }

  const buildXLSX = (rows: any[], cols: string[]) => {
    const sheetRows = [cols, ...rows.map(row => cols.map(col => row[col]))]
    const sheetData = sheetRows.map((row, r) => {
      const cells = row.map((value, c) => {
        const text = escapeXml(value)
        const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
        return `<c r="${columnLetter(c)}${r + 1}" t="inlineStr"><is><t${space}>${text}</t></is></c>`
      }).join('')
      return `<row r="${r + 1}">${cells}</row>`
    }).join('')

    const files = [
      {
        name: '[Content_Types].xml',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
      },
      {
        name: '_rels/.rels',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
      },
      {
        name: 'xl/workbook.xml',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`
      }
    ]
    return createZipBlob(files, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  }

  const exportXLSX = async () => {
    let rows: any[]
    let filename: string
    if (activeTab === 'query') {
      try {
        rows = await getQueryExportRows()
      } catch (e: any) {
        alert('导出失败: ' + (e?.message || e)); return
      }
      if (!rows.length) { alert('没有查询结果可导出'); return }
      filename = 'query_result.xlsx'
    } else {
      rows = data
      if (!rows.length) { alert('当前页没有数据可导出'); return }
      filename = `${selectedTable}.xlsx`
    }
    const cols = Object.keys(rows[0])
    const blob = buildXLSX(rows, cols)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
    setShowExport(false)
  }

  const exportCSV = async () => {
    let rows: any[]
    let filename: string
    if (activeTab === 'query') {
      try {
        rows = await getQueryExportRows()
      } catch (e: any) {
        alert('导出失败: ' + (e?.message || e)); return
      }
      if (!rows.length) { alert('没有查询结果可导出'); return }
      filename = 'query_result.csv'
    } else {
      rows = data
      if (!rows.length) { alert('当前页没有数据可导出'); return }
      filename = `${selectedTable}.csv`
    }
    const cols = Object.keys(rows[0])
    const escape = (v: any) => {
      if (v === null || v === undefined) return ''
      const s = formatValue(v)
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
      return s
    }
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
    setShowExport(false)
  }

  const highlightSQL = (sqlStr: string) => {
    return sqlStr
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/(--.*$|\/\*[\s\S]*?\*\/)/gm, '<span class="sql-comment">$1</span>')
      .replace(/('(?:[^'\\]|\\.)*')/g, '<span class="sql-string">$1</span>')
      .replace(/\b(CREATE|TABLE|PRIMARY|KEY|NOT|NULL|AUTO_INCREMENT|DEFAULT|COMMENT|ENGINE|CHARSET|COLLATE|INT|VARCHAR|TEXT|DATETIME|TIMESTAMP|ENUM|SET|DECIMAL|FLOAT|DOUBLE|CHAR|TINYINT|SMALLINT|MEDIUMINT|BIGINT|DATE|TIME|YEAR|BLOB|LONGTEXT|MEDIUMTEXT|TINYTEXT|UNSIGNED|UNIQUE|ON|UPDATE|CURRENT_TIMESTAMP|ROW_FORMAT|DYNAMIC)\b/gi, '<span class="sql-keyword">$1</span>')
      .replace(/\b(\d+)\b/g, '<span class="sql-number">$1</span>')
  }

  const exportSQL = async () => {
    let rows: any[]
    let tableName: string
    if (activeTab === 'query') {
      try {
        rows = await getQueryExportRows()
      } catch (e: any) {
        alert('导出失败: ' + (e?.message || e)); return
      }
      if (!rows.length) { alert('没有查询结果可导出'); return }
      tableName = 'query_result'
    } else {
      rows = data
      if (!rows.length) { alert('当前页没有数据可导出'); return }
      tableName = selectedTable
    }
    const cols = Object.keys(rows[0])
    const escSql = (v: any) => v === null || v === undefined ? 'NULL' : `'${formatValue(v).replace(/'/g, "\\'")}'`
    const inserts = rows.map(r =>
      `INSERT INTO \`${tableName}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(c => escSql(r[c])).join(', ')});`
    )
    const sqlText = activeTab === 'query' ? `-- Query Result\n` + inserts.join('\n') : `-- ${selectedDb}.${tableName}\n` + inserts.join('\n')
    const blob = new Blob([sqlText], { type: 'text/plain;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${tableName}.sql`; a.click()
    URL.revokeObjectURL(url)
    setShowExport(false)
  }

  const totalPages = Math.ceil(Number(total) / (pageSize > 0 ? pageSize : 100)) || 1
  const columns = allColumns.length > 0 ? allColumns : (data[0] ? Object.keys(data[0]) : [])
  const dataVirtualRange = useMemo(() => getVirtualRange(data.length, dataVirtualScroll), [data.length, dataVirtualScroll])
  const queryVirtualRange = useMemo(() => getVirtualRange(queryResultData.length, queryVirtualScroll), [queryResultData.length, queryVirtualScroll])
  const LOG_PARSER_EXAMPLE_SQL = 'select *  from agc_users where name = ? and id in (?,?,?)'
  const LOG_PARSER_EXAMPLE_PARAMS = 'hello(String), 1207895(Long), 1207901(Integer), 1207909(Integer)'

  const splitLogParams = (paramsText: string) => {
    const params: string[] = []
    let current = ''
    let quote: 'single' | 'double' | null = null
    let escaped = false
    for (const ch of paramsText) {
      if (escaped) {
        current += ch
        escaped = false
        continue
      }
      if (ch === '\\') {
        current += ch
        escaped = true
        continue
      }
      if (ch === "'" && quote !== 'double') {
        quote = quote === 'single' ? null : 'single'
        current += ch
        continue
      }
      if (ch === '"' && quote !== 'single') {
        quote = quote === 'double' ? null : 'double'
        current += ch
        continue
      }
      if (ch === ',' && !quote) {
        const trimmed = current.trim()
        if (trimmed) params.push(trimmed)
        current = ''
        continue
      }
      current += ch
    }
    const trimmed = current.trim()
    if (trimmed) params.push(trimmed)
    return params
  }

  const normalizeJavaType = (type?: string) => type?.split('.').pop()?.toLowerCase()

  const stripJavaTypeSuffix = (raw: string) => {
    const value = raw.trim()
    const match = value.match(/^(.*)\(([A-Za-z0-9_.$]+)\)$/)
    if (!match) return { value, type: undefined as string | undefined }
    const type = match[2]
    const normalized = normalizeJavaType(type)
    const knownTypes = new Set(['string', 'long', 'integer', 'int', 'short', 'byte', 'double', 'float', 'bigdecimal', 'biginteger', 'boolean', 'date', 'time', 'timestamp', 'localdate', 'localdatetime', 'localtime'])
    if (type.startsWith('java.') || (normalized && knownTypes.has(normalized))) return { value: match[1].trim(), type }
    return { value, type: undefined as string | undefined }
  }

  const unquoteLogParam = (value: string) => {
    const trimmed = value.trim()
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1)
    }
    return trimmed
  }

  const toSqlLiteral = (rawParam: string) => {
    const parsed = stripJavaTypeSuffix(rawParam)
    const rawValue = parsed.value.trim()
    const normalizedType = normalizeJavaType(parsed.type)
    const lower = rawValue.toLowerCase()
    if (lower === 'null' || lower === '<null>') return 'NULL'
    if (normalizedType === 'boolean' || (!normalizedType && (lower === 'true' || lower === 'false'))) {
      return lower === 'true' ? 'TRUE' : 'FALSE'
    }
    const numericTypes = new Set(['long', 'integer', 'int', 'short', 'byte', 'double', 'float', 'bigdecimal', 'biginteger'])
    if ((numericTypes.has(normalizedType || '') || !normalizedType) && /^-?\d+(\.\d+)?$/.test(rawValue)) return rawValue
    if (rawValue.startsWith("'") && rawValue.endsWith("'")) return rawValue
    const unquoted = unquoteLogParam(rawValue)
    return `'${unquoted.replace(/'/g, "''")}'`
  }

  const replaceSqlPlaceholders = (sqlText: string, params: string[]) => {
    let result = ''
    let paramIndex = 0
    let placeholderCount = 0
    let quote: 'single' | 'double' | 'backtick' | null = null
    let lineComment = false
    let blockComment = false
    for (let i = 0; i < sqlText.length; i++) {
      const ch = sqlText[i]
      const next = sqlText[i + 1]
      if (lineComment) {
        result += ch
        if (ch === '\n') lineComment = false
        continue
      }
      if (blockComment) {
        result += ch
        if (ch === '*' && next === '/') {
          result += next
          i++
          blockComment = false
        }
        continue
      }
      if (!quote && ch === '-' && next === '-') {
        result += ch + next
        i++
        lineComment = true
        continue
      }
      if (!quote && ch === '/' && next === '*') {
        result += ch + next
        i++
        blockComment = true
        continue
      }
      if (ch === "'" && quote !== 'double' && quote !== 'backtick') {
        quote = quote === 'single' ? null : 'single'
        result += ch
        continue
      }
      if (ch === '"' && quote !== 'single' && quote !== 'backtick') {
        quote = quote === 'double' ? null : 'double'
        result += ch
        continue
      }
      if (ch === '`' && quote !== 'single' && quote !== 'double') {
        quote = quote === 'backtick' ? null : 'backtick'
        result += ch
        continue
      }
      if (ch === '?' && !quote) {
        placeholderCount++
        if (paramIndex < params.length) result += toSqlLiteral(params[paramIndex++])
        else result += ch
        continue
      }
      result += ch
    }
    let error = ''
    if (paramIndex < placeholderCount) error = `参数数量不足：占位符 ${placeholderCount} 个，参数 ${params.length} 个`
    else if (params.length > placeholderCount) error = `参数数量多于占位符：占位符 ${placeholderCount} 个，参数 ${params.length} 个`
    return { sql: result, placeholderCount, usedParamCount: paramIndex, paramCount: params.length, error }
  }

  const parseLogStatement = () => {
    const sqlText = logParserSql.trim() ? logParserSql : LOG_PARSER_EXAMPLE_SQL
    const paramsText = logParserParams.trim() ? logParserParams : LOG_PARSER_EXAMPLE_PARAMS
    if (!logParserSql.trim()) setLogParserSql(sqlText)
    if (!logParserParams.trim()) setLogParserParams(paramsText)
    const params = splitLogParams(paramsText)
    const parsed = replaceSqlPlaceholders(sqlText, params)
    setLogParserOutput(parsed.sql)
    setLogParserError(parsed.error)
    showToast(parsed.error ? '解析完成，但参数数量不匹配' : '解析完成')
  }

  const copyParsedLogSql = () => {
    if (!logParserOutput) return
    navigator.clipboard.writeText(logParserOutput)
    showToast('解析 SQL 已复制')
  }

  const runParsedLogSql = () => {
    if (!logParserOutput) return
    const currentSql = sqlEditorRef.current?.state.doc.toString() ?? sqlValueRef.current
    const prefix = currentSql.trimEnd()
    const separator = prefix ? '\n\n' : ''
    const nextSql = `${prefix}${separator}${logParserOutput}`
    const selectionStart = prefix.length + separator.length
    const selectionEnd = selectionStart + logParserOutput.length
    setSql(nextSql)
    setActiveTab('query')
    setTimeout(() => {
      if (sqlEditorRef.current) {
        setSqlSelectionRange(selectionStart, selectionEnd)
      }
    }, 0)
    executeQuery(false, logParserOutput)
  }

  const clearLogParser = () => {
    setLogParserSql('')
    setLogParserParams('')
    setLogParserOutput('')
    setLogParserError('')
  }

  const beautifyJson = () => {
    if (!jsonBeautifyInput.trim()) {
      setJsonBeautifyOutput('')
      setJsonBeautifyError('请输入 JSON 内容')
      return
    }
    try {
      const parsed = JSON.parse(jsonBeautifyInput)
      setJsonBeautifyOutput(JSON.stringify(parsed, null, 2))
      setJsonBeautifyError('')
      showToast('JSON 美化完成')
    } catch (e: any) {
      setJsonBeautifyOutput('')
      setJsonBeautifyError(`JSON 格式错误：${e?.message || '无法解析'}`)
    }
  }

  const clearJsonBeautify = () => {
    setJsonBeautifyInput('')
    setJsonBeautifyOutput('')
    setJsonBeautifyError('')
  }

  const copyBeautifiedJson = () => {
    if (!jsonBeautifyOutput) return
    navigator.clipboard.writeText(jsonBeautifyOutput)
    showToast('JSON 已复制')
  }

  const formatValue = (v: any): string => {
    if (v === null || v === undefined) return ''
    const pad = (n: number) => String(n).padStart(2, '0')
    const fmtDate = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    if (v instanceof Date || (typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Date]')) {
      return fmtDate(new Date(v))
    }
    if (typeof v === 'string') {
      // ISO format: 2020-04-27T10:10:26...
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
        const d = new Date(v)
        if (!isNaN(d.getTime())) return fmtDate(d)
      }
      // JS Date.toString() format: Mon Apr 27 2020 18:10:26 GMT+0800 ...
      if (/^[A-Z][a-z]{2}\s[A-Z][a-z]{2}\s\d{1,2}\s\d{4}/.test(v)) {
        const d = new Date(v)
        if (!isNaN(d.getTime())) return fmtDate(d)
      }
      // MySQL datetime string with timezone offset: 2020-04-27 18:10:26+08:00
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]/.test(v)) {
        const d = new Date(v.replace(' ', 'T'))
        if (!isNaN(d.getTime())) return fmtDate(d)
      }
    }
    return String(v)
  }

  const copyHeaderColumn = (col: string, isQuery: boolean) => {
    const rows = isQuery ? queryResultData : data
    navigator.clipboard.writeText(rows.map(row => formatValue(row?.[col])).join('\n'))
    setHeaderContextMenu(null)
    showToast('整列数据已复制')
  }

  const copyHeaderName = (col: string) => {
    navigator.clipboard.writeText(col)
    setHeaderContextMenu(null)
    showToast(`字段名 ${col} 已复制`)
  }

  const copyHeaderComment = (comment: string) => {
    navigator.clipboard.writeText(comment)
    setHeaderContextMenu(null)
    showToast(comment ? '注释已复制' : '无注释可复制')
  }

  const startResize = (col: string, e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = getDataColumnWidth(col)

    const onMouseMove = (me: MouseEvent) => {
      setColumnWidths(prev => ({ ...prev, [col]: Math.max(getColumnMinWidth(col), startWidth + me.clientX - startX) }))
    }
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }

  // --- Row drag selection helpers ---
  const handleRowMouseDown = (i: number, e: React.MouseEvent, isQuery: boolean) => {
    e.preventDefault()
    rowSelectionActive.current = true
    if (isQuery) {
      setQueryRowDragStart(i)
      setQuerySelectedRows(new Set([i]))
    } else {
      setRowDragStart(i)
      setSelectedRows(new Set([i]))
    }
  }

  const handleRowMouseEnter = (i: number, isQuery: boolean) => {
    if (isQuery) {
      if (queryRowDragStart === null) return
      const start = Math.min(queryRowDragStart, i)
      const end = Math.max(queryRowDragStart, i)
      const next = new Set<number>()
      for (let r = start; r <= end; r++) next.add(r)
      setQuerySelectedRows(next)
    } else {
      if (rowDragStart === null) return
      const start = Math.min(rowDragStart, i)
      const end = Math.max(rowDragStart, i)
      const next = new Set<number>()
      for (let r = start; r <= end; r++) next.add(r)
      setSelectedRows(next)
    }
  }

  const handleRowMouseUp = (isQuery: boolean) => {
    if (isQuery) setQueryRowDragStart(null)
    else setRowDragStart(null)
  }

  // --- Col drag selection helpers ---
  const handleColCellMouseDown = (rowIndex: number, col: string, e: React.MouseEvent, isQuery: boolean) => {
    // Only start col drag if shift key not held; regular click handled by input
    // We use mousedown on the TD wrapper to detect drag
    if (isQuery) {
      setQueryColDragState({ col, startRow: rowIndex })
    } else {
      setColDragState({ col, startRow: rowIndex })
    }
  }

  const handleColCellMouseEnter = (rowIndex: number, col: string, isQuery: boolean) => {
    if (isQuery) {
      if (!queryColDragState || queryColDragState.col !== col) return
      const start = Math.min(queryColDragState.startRow, rowIndex)
      const end = Math.max(queryColDragState.startRow, rowIndex)
      // Select these rows
      const next = new Set<number>()
      for (let r = start; r <= end; r++) next.add(r)
      setQuerySelectedRows(next)
    } else {
      if (!colDragState || colDragState.col !== col) return
      const start = Math.min(colDragState.startRow, rowIndex)
      const end = Math.max(colDragState.startRow, rowIndex)
      const next = new Set<number>()
      for (let r = start; r <= end; r++) next.add(r)
      setSelectedRows(next)
    }
  }

  const handleColCellMouseUp = (col: string, isQuery: boolean) => {
    if (isQuery) {
      setQueryColDragState(null)
    } else {
      setColDragState(null)
    }
  }

  // Bulk edit: when multiple rows are selected and user types in a col cell, apply to all selected rows
  const handleBulkColEdit = (rowIndex: number, col: string, value: any, isQuery: boolean) => {
    const selRows = isQuery ? querySelectedRows : selectedRows
    if (selRows.size > 1 && selRows.has(rowIndex)) {
      // Apply to all selected rows
      if (isQuery) {
        const newEdits = new Map(queryEdits)
        for (const r of selRows) {
          if (!newEdits.has(r)) newEdits.set(r, {})
          newEdits.get(r)![col] = value
        }
        setQueryEdits(newEdits)
      } else {
        const newEdits = new Map(edits)
        for (const r of selRows) {
          if (!newEdits.has(r)) newEdits.set(r, {})
          newEdits.get(r)![col] = value
        }
        setEdits(newEdits)
      }
    } else {
      if (isQuery) handleQueryCellEdit(rowIndex, col, value)
      else handleCellEdit(rowIndex, col, value)
    }
  }

  // --- Toolbar button style helpers ---
  const btnActive = `px-3 py-1.5 text-sm border ${appleControl} ${dark ? 'border-[#3e3e42] text-white' : 'border-gray-200 text-gray-800'}`
  const btnDisabled = `px-3 py-1.5 text-sm border rounded-xl shadow-sm opacity-30 cursor-not-allowed ${dark ? 'border-[#3e3e42] text-gray-500 bg-[#2a2a2c]' : 'border-gray-200 text-gray-400 bg-white'}`
  const btnGreen = `px-3 py-1.5 text-sm rounded-xl border shadow-sm transition-colors border-green-500/60 text-green-600 ${dark ? 'bg-green-900/10 hover:bg-green-900/25' : 'bg-green-50/70 hover:bg-green-100'}`
  const btnRed = `px-3 py-1.5 text-sm rounded-xl border shadow-sm transition-colors border-red-500/60 text-red-500 ${dark ? 'bg-red-900/10 hover:bg-red-900/25' : 'bg-red-50/70 hover:bg-red-100'}`
  const btnBlue = `px-3 py-1.5 text-sm rounded-xl border shadow-sm transition-colors border-blue-500/60 text-blue-600 ${dark ? 'bg-blue-900/10 hover:bg-blue-900/25' : 'bg-blue-50/70 hover:bg-blue-100'}`

  const renderToolbar = (opts: {
    hasEdits: boolean
    hasNewRow: boolean
    hasSelected: boolean
    onAdd: () => void
    onDelete?: () => void
    onSubmit: () => void
    onDiscard: () => void
    onRefresh: () => void
    page: number
    totalPages: number
    onFirst: () => void
    onPrev: () => void
    onNext: () => void
    onLast: () => void
    pageSizeVal: string
    onPageSizeChange: (v: string) => void
    onPageSizeCommit: (v: string) => void
    totalCount: number
    onPageChange?: (v: number) => void
    currentPage?: number
    showDdlPreview?: boolean
    pageSizeMenuKey: string
  }) => {
    const isDirty = opts.hasEdits || opts.hasNewRow
    const pageSizeInputWidth = `calc(${Math.max(5, String(opts.pageSizeVal || '').length)}ch + 20px)`
    return (
      <div className={`flex items-center gap-1 px-3 py-1.5 border-t ${border} ${bg2}`}>
        {/* Add */}
        <button onClick={opts.onAdd} className={btnBlue} title="新增行">+ 新增</button>

        {/* Delete */}
        {opts.hasSelected && opts.onDelete
          ? <button onClick={opts.onDelete} className={btnRed} title="删除所选行">- 删除</button>
          : <button disabled className={btnDisabled} title={opts.onDelete ? "请先选中行" : "查询结果无主键id，不支持删除"}>- 删除</button>
        }

        {/* Submit */}
        {isDirty
          ? <button onClick={opts.onSubmit} className={btnGreen} title="提交修改">✓ 提交</button>
          : <button disabled className={btnDisabled} title="暂无修改">✓ 提交</button>
        }

        {/* Discard */}
        {isDirty
          ? <button onClick={opts.onDiscard} className={btnRed} title="撤销修改">✕ 撤销</button>
          : <button disabled className={btnDisabled} title="暂无修改">✕ 撤销</button>
        }

        {/* DDL preview */}
        {opts.showDdlPreview && (
          <div
            className="relative"
            onMouseEnter={() => { setDdlPreviewVisible(true); ensureTableDDL() }}
            onMouseLeave={() => setDdlPreviewVisible(false)}
          >
            <button onClick={copyCurrentDDL} className={btnActive} title="预览并复制当前表 DDL">
              {ddlPreviewVisible ? '复制' : '预览'}
            </button>
            {ddlPreviewVisible && (
              <div className={`absolute left-0 bottom-full mb-2 z-[80] w-[760px] max-w-[80vw] h-[520px] max-h-[70vh] rounded border shadow-2xl overflow-auto scrollbar-thin ${dark ? 'bg-[#1e1e1e] border-[#555] text-gray-100' : 'bg-white border-gray-300 text-gray-900'}`}>
                <div className={`sticky top-0 px-3 py-2 border-b ${border} ${bg2} text-xs flex items-center justify-between`}>
                  <span>当前表 DDL 预览</span>
                  <span className={textSub}>点击“复制”复制全部 DDL</span>
                </div>
                <pre className="p-4 text-xs font-mono whitespace-pre-wrap break-words">
                  {ddl || 'DDL 加载中...'}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Refresh */}
        <button onClick={opts.onRefresh} className={btnActive} title="刷新">↻</button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Pagination + page size together on the right */}
        <button onClick={opts.onFirst} disabled={opts.page === 1} className={opts.page === 1 ? btnDisabled : btnActive}>首页</button>
        <button onClick={opts.onPrev} disabled={opts.page === 1} className={opts.page === 1 ? btnDisabled : btnActive}>上一页</button>
        <span className={`text-xs ${textSub} px-1`}>{opts.page} / {opts.totalPages || 1}</span>
        <button onClick={opts.onNext} disabled={opts.page >= (opts.totalPages || 1)} className={opts.page >= (opts.totalPages || 1) ? btnDisabled : btnActive}>下一页</button>
        <button onClick={opts.onLast} disabled={opts.page >= (opts.totalPages || 1)} className={opts.page >= (opts.totalPages || 1) ? btnDisabled : btnActive}>末页</button>

        <span className={`mx-1 ${dark ? 'text-gray-600' : 'text-gray-300'}`}>|</span>
        <span className={`text-xs ${textSub}`}>每页</span>
        <div className="relative">
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={opts.pageSizeVal}
            onFocus={() => setPageSizeMenuKey(opts.pageSizeMenuKey)}
            onClick={() => setPageSizeMenuKey(opts.pageSizeMenuKey)}
            onChange={e => opts.onPageSizeChange(e.target.value)}
            onBlur={e => {
              opts.onPageSizeCommit(e.target.value)
              setTimeout(() => setPageSizeMenuKey(current => current === opts.pageSizeMenuKey ? null : current), 100)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                opts.onPageSizeCommit((e.currentTarget as HTMLInputElement).value)
                ;(e.currentTarget as HTMLInputElement).blur()
              }
            }}
            className={`${inputCls} text-xs py-0.5 font-normal`}
            style={{ width: pageSizeInputWidth, minWidth: 72 }}
            title="输入或选择每页条数"
          />
          {pageSizeMenuKey === opts.pageSizeMenuKey && (
            <div className={`absolute right-0 bottom-full mb-1 z-50 w-full min-w-[72px] rounded-xl border shadow-lg overflow-hidden ${bg2} ${border}`}>
              {PAGE_SIZE_OPTIONS.map(size => (
                <button
                  key={size}
                  type="button"
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => {
                    const value = String(size)
                    opts.onPageSizeChange(value)
                    opts.onPageSizeCommit(value)
                    setPageSizeMenuKey(null)
                  }}
                  className={`w-full px-3 py-1.5 text-left text-xs font-normal ${hover}`}
                >
                  {size}
                </button>
              ))}
            </div>
          )}
        </div>
        <span className={`text-xs ${textSub}`}>条 (共 {opts.totalCount} 条)</span>
      </div>
    )
  }

  return (
    <div
      className={`flex h-full ${bg} ${text}`}
      onClick={() => { setContextMenu(null); setHeaderContextMenu(null); setTabContextMenu(null); setQueryContextMenu(null) }}
      onMouseDown={e => {
        if (rowSelectionActive.current) { rowSelectionActive.current = false; return }
        const target = e.target as HTMLElement
        // Always preserve selection when clicking toolbar buttons
        if (target.closest('button')) return

        // Check if clicking on a scrollbar
        // When clicking scrollbar, offsetX/Y can be outside clientWidth/Height
        const isScrollbarClick = (el: HTMLElement) => {
          const rect = el.getBoundingClientRect()
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          // Vertical scrollbar: x >= clientWidth
          // Horizontal scrollbar: y >= clientHeight
          return x >= el.clientWidth || y >= el.clientHeight
        }

        // Check if any ancestor (including target itself) has scrollbar clicked
        let element = target
        while (element && element !== e.currentTarget) {
          if ((element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth) && isScrollbarClick(element)) {
            return // Preserve selection when clicking scrollbar
          }
          element = element.parentElement as HTMLElement
        }

        const tr = target.closest('tr')
        if (tr) {
          // Inside a table row: preserve only if that row is selected
          const idx = parseInt(tr.getAttribute('data-row-index') || '-1')
          const isSelected = activeTab === 'query' ? querySelectedRows.has(idx) : selectedRows.has(idx)
          if (idx >= 0 && isSelected) return
        } else {
          // Outside any table row: preserve if clicking a toolbar input/select
          if (target.closest('select') || target.closest('input') || target.closest('textarea')) return
        }
        setSelectedRows(new Set()); setQuerySelectedRows(new Set())
      }}
      onMouseUp={() => { handleRowMouseUp(false); handleRowMouseUp(true); setColDragState(null); setQueryColDragState(null) }}
    >
      {/* Context menu */}
      {contextMenu && (
        <div
          className={`fixed z-50 rounded-2xl border p-1 shadow-2xl backdrop-blur ${bg2} ${border}`}
          style={{ top: contextMenu.y, left: contextMenu.x, width: 'fit-content' }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={() => copyRowSQL(contextMenu.rowIndex)} className={`block rounded-xl text-left px-3 py-2 text-sm whitespace-nowrap transition-colors ${hover}`}>复制 插入SQL</button>
          <button onClick={() => copyRowUpdateSQL(contextMenu.rowIndex)} className={`block rounded-xl text-left px-3 py-2 text-sm whitespace-nowrap transition-colors ${hover}`}>复制 更新SQL</button>
          <button onClick={() => copyRowJSON(contextMenu.rowIndex)} className={`block rounded-xl text-left px-3 py-2 text-sm whitespace-nowrap transition-colors ${hover}`}>复制 JSON</button>
        </div>
      )}

      {headerContextMenu && (
        <div
          className={`fixed z-50 rounded-2xl border p-1 shadow-2xl backdrop-blur ${bg2} ${border}`}
          style={{ top: headerContextMenu.y, left: headerContextMenu.x, width: 'fit-content' }}
          onClick={e => e.stopPropagation()}
        >
          <button onClick={() => copyHeaderColumn(headerContextMenu.col, headerContextMenu.isQuery)} className={`block rounded-xl text-left px-3 py-2 text-sm whitespace-nowrap transition-colors ${hover}`}>复制整列数据</button>
          <button onClick={() => copyHeaderName(headerContextMenu.col)} className={`block rounded-xl text-left px-3 py-2 text-sm whitespace-nowrap transition-colors ${hover}`}>复制字段名</button>
          <button onClick={() => copyHeaderComment(headerContextMenu.comment)} className={`block rounded-xl text-left px-3 py-2 text-sm whitespace-nowrap transition-colors ${hover}`}>复制注释</button>
        </div>
      )}

      {/* Delete confirm dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setDeleteConfirm(null)}>
          <div className={`${bg} rounded-lg w-80 border ${border} shadow-2xl p-6`} onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold mb-3">确认删除</h3>
            <p className={`text-sm ${textSub} mb-5`}>确定要删除选中的 {deleteConfirm.rows.size} 行数据吗？此操作不可撤销。</p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleteConfirm(null)} className={`px-4 py-1.5 rounded-xl text-sm border ${dark ? 'border-[#3e3e42] hover:bg-[#3e3e42]' : 'border-gray-300 hover:bg-gray-100'}`}>取消</button>
              <button onClick={() => deleteSelectedRows(deleteConfirm.rows, deleteConfirm.isQuery)} className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm">确认删除</button>
            </div>
          </div>
        </div>
      )}

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Tab bar */}
        <div
          onWheel={e => {
            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
            e.currentTarget.scrollLeft += delta
          }}
          className={`border-b ${border} ${bg2} flex items-center gap-1 px-2 py-1 overflow-x-auto flex-shrink-0 [&::-webkit-scrollbar]:h-1.5`}
          style={{ scrollbarWidth: 'thin' }}
        >
          {tabs.map(tab => {
            const isActive = activeTabId === tab.id
            const fullLabel = tab.table
              ? `${tab.table}@${tab.db}(${connection.name})`
              : `${tab.db}(${connection.name})`
            const displayLabel = tab.label.length > 16 ? tab.label.slice(0, 16) + '…' : tab.label
            return (
              <div
                key={tab.id}
                data-tab-id={tab.id}
                draggable
                onDragStart={e => {
                  setDraggedTabId(tab.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', tab.id)
                }}
                onDragOver={e => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
                  if (draggedTabId && draggedTabId !== tab.id) setTabDropTarget({ id: tab.id, side })
                }}
                onDragLeave={e => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node)) setTabDropTarget(null)
                }}
                onDrop={e => {
                  e.preventDefault()
                  const fromId = e.dataTransfer.getData('text/plain') || draggedTabId
                  if (fromId) reorderTabs(fromId, tab.id, tabDropTarget?.side ?? 'before')
                  setDraggedTabId(null)
                  setTabDropTarget(null)
                }}
                onDragEnd={() => { setDraggedTabId(null); setTabDropTarget(null) }}
                onMouseEnter={e => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  tabTooltipTimer.current = setTimeout(() => {
                    setTabTooltip({ text: fullLabel, x: rect.left, y: rect.bottom + 4 })
                  }, 300)
                }}
                onMouseLeave={() => {
                  if (tabTooltipTimer.current) clearTimeout(tabTooltipTimer.current)
                  setTabTooltip(null)
                }}
                onClick={() => {
                  if (tabTooltipTimer.current) clearTimeout(tabTooltipTimer.current)
                  setTabTooltip(null)
                  if (tab.table) {
                    switchToTab(tab.id, tab.db, tab.table)
                  } else {
                    // db tab
                    saveCurrentTabState()
                    activeTabIdRef.current = tab.id
                    setActiveTabId(tab.id)
                    onTabChange?.(tab.db, '')
                  }
                }}
                onContextMenu={e => { e.preventDefault(); setTabContextMenu({ x: e.clientX, y: e.clientY, tabId: tab.id }) }}
                className={`relative flex items-center gap-2 px-3 py-1.5 cursor-pointer min-w-0 max-w-48 overflow-visible flex-shrink-0 rounded-xl border transition-colors ${draggedTabId === tab.id ? 'opacity-50' : ''} ${
                  isActive
                    ? (dark ? 'bg-[#3f4652] border-[#556070] text-white shadow-sm' : 'bg-blue-100 border-blue-200 text-gray-900 shadow-sm')
                    : `${dark ? 'bg-[#252526] border-[#3e3e42] hover:bg-[#303033]' : 'bg-white border-gray-200 hover:bg-gray-100'} ${text}`
                }`}
              >
                {tabDropTarget?.id === tab.id && draggedTabId !== tab.id && (
                  <span className={`absolute top-1 bottom-1 ${tabDropTarget.side === 'before' ? '-left-1' : '-right-1'} w-1.5 rounded-full shadow-lg ${dark ? 'bg-blue-400 shadow-blue-400/40' : 'bg-blue-500 shadow-blue-500/30'}`} />
                )}
                {tab.type === 'db'
                  ? <img src={haitunGreen} className="w-4 h-4 flex-shrink-0" alt="" />
                  : <span className="text-blue-400 text-sm">▤</span>
                }
                <span className="text-sm truncate min-w-0 flex-1">{displayLabel}</span>
                <button
                  onClick={e => { e.stopPropagation(); closeTab(tab.id) }}
                  className={`text-xs flex-shrink-0 w-4 h-4 rounded-full text-center leading-4 ${dark ? 'text-gray-400 hover:text-white hover:bg-white/10' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200'}`}
                >✕</button>
              </div>
            )
          })}
        </div>

        {/* Tab tooltip */}
        {tabTooltip && (
          <div
            className={`fixed z-[100] px-2 py-1 text-xs rounded shadow-lg pointer-events-none ${dark ? 'bg-[#3c3c3c] text-white border border-[#555]' : 'bg-gray-800 text-white'}`}
            style={{ left: tabTooltip.x, top: tabTooltip.y }}
          >
            {tabTooltip.text}
          </div>
        )}

        {/* Tab context menu */}
        {tabContextMenu && (
          <div
            className={`fixed z-50 rounded border shadow-lg ${bg2} ${border}`}
            style={{ top: tabContextMenu.y, left: tabContextMenu.x }}
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => { closeTab(tabContextMenu.tabId); setTabContextMenu(null) }} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>关闭当前标签页</button>
            <button onClick={() => { closeOtherTabs(tabContextMenu.tabId); setTabContextMenu(null) }} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>关闭其他标签页</button>
            <button onClick={() => { closeAllTabs(); setTabContextMenu(null) }} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>关闭所有标签页</button>
          </div>
        )}

        {activeTabId && tabs.find(t => t.id === activeTabId)?.type === 'table' && selectedTable ? (
          <>
            {/* Sub-tabs */}
            <div className={`flex items-center border-b ${border} ${bg2}`}>
              <div className="flex flex-1">
                {[
                  { key: 'data', label: '数据' },
                  { key: 'structure', label: '结构' },
                  { key: 'ddl', label: 'DDL' },
                  { key: 'query', label: '查询' },
                  { key: 'logParser', label: '日志语句解析' },
                  { key: 'jsonBeautify', label: 'JSON美化' }
                ].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => {
                      if (activeTab === 'data') savedScrollTop.current = tableBodyRef.current?.scrollTop ?? 0
                      setShowExport(false)
                      setActiveTab(tab.key as Tab)
                      if (tab.key === 'data') setTimeout(() => {
                        if (tableBodyRef.current) tableBodyRef.current.scrollTop = savedScrollTop.current
                        syncVirtualScroll(tableBodyRef.current, setDataVirtualScroll)
                      }, 0)
                    }}
                    className={`px-4 py-2 text-sm border-b-2 ${
                      activeTab === tab.key ? 'border-blue-600' : `border-transparent ${textSub} hover:text-inherit`
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
              {((activeTab === 'data') || (activeTab === 'query' && queryResult?.success && Array.isArray(queryResult.data) && queryResult.data.length > 0)) && (
                <div ref={exportRef} className="pr-3 relative flex-shrink-0">
                  <button
                    onClick={() => setShowExport(v => !v)}
                    className={btnActive}
                  >
                    ↓ 导出
                  </button>
                  {showExport && (
                    <div className={`absolute right-0 top-full mt-1 w-36 rounded-xl border shadow-lg z-50 overflow-hidden ${bg2} ${border}`}>
                      <button onClick={exportXLSX} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>导出 XLSX</button>
                      <button onClick={exportCSV} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>导出 CSV</button>
                      <button onClick={exportSQL} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>导出 SQL</button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Data Tab */}
            <div className="flex-1 flex flex-col overflow-hidden" style={{ display: activeTab === 'data' ? 'flex' : 'none' }}>
                {/* Filters */}
                <div className={`px-3 py-2 border-b overflow-y-auto scrollbar-thin ${border} ${bg2}`} style={{ maxHeight: '33vh' }}>
                  {(() => {
                    // Group filters by segment: ungrouped = no group id, grouped = same group id
                    type SegmentUI = { type: 'single'; index: number } | { type: 'group'; groupId: number; indices: number[] }
                    const segments: SegmentUI[] = []
                    const seenGroups = new Set<number>()
                    filters.forEach((f, i) => {
                      if (f.group == null) {
                        segments.push({ type: 'single', index: i })
                      } else if (!seenGroups.has(f.group)) {
                        seenGroups.add(f.group)
                        const indices = filters.map((ff, ii) => ff.group === f.group ? ii : -1).filter(x => x >= 0)
                        segments.push({ type: 'group', groupId: f.group, indices })
                      }
                    })

                    const updateFilter = (i: number, patch: Partial<Filter>) => {
                      setFilters(prev => { const n = [...prev]; n[i] = { ...n[i], ...patch }; return n })
                    }
                    const removeFilter = (i: number) => {
                      setFilters(prev => prev.length > 1 ? prev.filter((_, idx) => idx !== i) : [{ column: '', op: '=', value: '', logic: 'AND' }])
                    }
                    const filterToggle = (i: number, enabled: boolean) => (
                      <label className="flex items-center" title={enabled ? '取消勾选后不参与筛选' : '勾选后参与筛选'}>
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={e => updateFilter(i, { enabled: e.target.checked })}
                          className="accent-blue-600"
                        />
                      </label>
                    )

                    const addButtons = (
                      <>
                        <button
                          onClick={() => setFilters(prev => [...prev, { column: '', op: '=', value: '', logic: 'AND' }])}
                          className={`px-3 py-1 rounded-xl text-sm border ${dark ? 'border-[#3e3e42] hover:bg-[#3e3e42] text-gray-300' : 'border-gray-300 hover:bg-gray-100 text-gray-600'}`}
                          title="添加条件"
                        >+</button>
                        <button
                          onClick={() => {
                            const newGroupId = Date.now()
                            const logic: 'AND' | 'OR' = 'AND'
                            setFilters(prev => [...prev, { column: '', op: '=', value: '', logic, group: newGroupId }])
                          }}
                          className={`px-3 py-1 rounded-xl text-sm border ${dark ? 'border-[#3e3e42] hover:bg-[#3e3e42] text-gray-300' : 'border-gray-300 hover:bg-gray-100 text-gray-600'}`}
                          title="添加括号条件组"
                        >()+</button>
                      </>
                    )

                    const actionButtons = (
                      <div className="absolute right-0 top-0 z-20 flex gap-2 flex-wrap">
                        <button onClick={applyFilters} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm shadow-sm transition-colors">筛选</button>
                        <button
                          onClick={() => {
                            const empty = [{ column: '', op: '=', value: '', logic: 'AND' as const }]
                            setFilters(empty)
                            setPage(1)
                            needsReload.current = true
                            loadTableData(1, empty)
                          }}
                          className={`px-4 py-1 rounded-xl text-sm border ${dark ? 'border-[#3e3e42] hover:bg-[#3e3e42]' : 'border-gray-300 hover:bg-gray-100'}`}
                        >清空</button>
                      </div>
                    )

                    // Index of this segment in the segments array (for showing AND/OR between segments)
                    return (
                      <div className="relative flex flex-col gap-2 pr-[300px]">
                        {actionButtons}
                        {segments.map((seg, si) => {
                          const showSegLogic = si > 0
                          if (seg.type === 'single') {
                            const f = filters[seg.index]
                            const i = seg.index
                            const enabled = f.enabled !== false
                            return (
                              <div key={`s-${i}`} className="flex items-center gap-2">
                                {filterToggle(i, enabled)}
                                {showSegLogic && (
                                  <select value={f.logic ?? 'AND'} onChange={e => updateFilter(i, { logic: e.target.value as 'AND'|'OR' })} className={`w-20 ${inputCls}`}>
                                    <option value="AND">AND</option>
                                    <option value="OR">OR</option>
                                  </select>
                                )}
                                <select value={f.column} onChange={e => updateFilter(i, { column: e.target.value })} className={inputCls}>
                                  <option value="">选择字段</option>
                                  {columns.map(col => <option key={col} value={col}>{col}</option>)}
                                </select>
                                <select value={f.op} onChange={e => updateFilter(i, { op: e.target.value })} className={inputCls}>
                                  <option value="=">=</option>
                                  <option value="!=">!=</option>
                                  <option value="<">&lt;</option>
                                  <option value="<=">&lt;=</option>
                                  <option value=">">&gt;</option>
                                  <option value=">=">&gt;=</option>
                                  <option value="LIKE">like</option>
                                  <option value="CONTAINS">包含</option>
                                  <option value="NOT CONTAINS">不包含</option>
                                  <option value="IS NULL">是null</option>
                                  <option value="IS NOT NULL">不是null</option>
                                  <option value="IS EMPTY">是空的</option>
                                  <option value="IS NOT EMPTY">不是空的</option>
                                  <option value="BETWEEN">介于</option>
                                  <option value="NOT BETWEEN">不介于</option>
                                  <option value="IN">在列表</option>
                                  <option value="NOT IN">不在列表</option>
                                </select>
                                {!['IS NULL', 'IS NOT NULL', 'IS EMPTY', 'IS NOT EMPTY'].includes(f.op) && (
                                  <input type="text" placeholder={f.op.includes('BETWEEN') ? '值1,值2' : f.op.includes('IN') ? '值1,值2,值3' : '值'} value={f.value} onChange={e => updateFilter(i, { value: e.target.value })} className={`w-1/2 ${inputCls}`} />
                                )}
                                {si === 0 && addButtons}
                                {filters.length > 1 && (
                                  <button onClick={() => removeFilter(i)} className="px-2 py-1 text-red-500 hover:text-red-600 text-sm font-semibold" title="删除条件">-</button>
                                )}
                              </div>
                            )
                          } else {
                            // Group segment
                            return (
                              <div key={`g-${seg.groupId}`} className="flex items-start gap-2">
                                {showSegLogic && (
                                  <select
                                    value={filters[seg.indices[0]]?.logic ?? 'AND'}
                                    onChange={e => updateFilter(seg.indices[0], { logic: e.target.value as 'AND'|'OR' })}
                                    className={`w-20 mt-1 ${inputCls}`}
                                  >
                                    <option value="AND">AND</option>
                                    <option value="OR">OR</option>
                                  </select>
                                )}
                                <div className={`flex-1 flex flex-col gap-2 pl-2 border-l-2 ${dark ? 'border-blue-500' : 'border-blue-400'}`}>
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <span className={`text-xs ${dark ? 'text-gray-400' : 'text-gray-500'}`}>(</span>
                                  </div>
                                  {seg.indices.map((fi, pos) => {
                                    const f = filters[fi]
                                    const enabled = f.enabled !== false
                                    return (
                                      <div key={fi} className="flex items-center gap-2">
                                        {filterToggle(fi, enabled)}
                                        {pos > 0 && (
                                          <select value={f.logic ?? 'AND'} onChange={e => updateFilter(fi, { logic: e.target.value as 'AND'|'OR' })} className={`w-20 ${inputCls}`}>
                                            <option value="AND">AND</option>
                                            <option value="OR">OR</option>
                                          </select>
                                        )}
                                        <select value={f.column} onChange={e => updateFilter(fi, { column: e.target.value })} className={inputCls}>
                                          <option value="">选择字段</option>
                                          {columns.map(col => <option key={col} value={col}>{col}</option>)}
                                        </select>
                                        <select value={f.op} onChange={e => updateFilter(fi, { op: e.target.value })} className={inputCls}>
                                          <option value="=">=</option>
                                          <option value="!=">!=</option>
                                          <option value="<">&lt;</option>
                                          <option value="<=">&lt;=</option>
                                          <option value=">">&gt;</option>
                                          <option value=">=">&gt;=</option>
                                          <option value="LIKE">like</option>
                                          <option value="CONTAINS">包含</option>
                                          <option value="NOT CONTAINS">不包含</option>
                                          <option value="IS NULL">是null</option>
                                          <option value="IS NOT NULL">不是null</option>
                                          <option value="IS EMPTY">是空的</option>
                                          <option value="IS NOT EMPTY">不是空的</option>
                                          <option value="BETWEEN">介于</option>
                                          <option value="NOT BETWEEN">不介于</option>
                                          <option value="IN">在列表</option>
                                          <option value="NOT IN">不在列表</option>
                                        </select>
                                        {!['IS NULL', 'IS NOT NULL', 'IS EMPTY', 'IS NOT EMPTY'].includes(f.op) && (
                                          <input type="text" placeholder={f.op.includes('BETWEEN') ? '值1,值2' : f.op.includes('IN') ? '值1,值2,值3' : '值'} value={f.value} onChange={e => updateFilter(fi, { value: e.target.value })} className={`w-1/2 ${inputCls}`} />
                                        )}
                                        {si === 0 && pos === 0 && addButtons}
                                        {filters.length > 1 && (
                                          <button
                                            onClick={() => {
                                              removeFilter(fi)
                                            }}
                                            className="px-2 py-1 text-red-500 hover:text-red-600 text-sm font-semibold"
                                            title="删除条件"
                                          >-</button>
                                        )}
                                      </div>
                                    )
                                  })}
                                  {/* Add condition inside group */}
                                  <button
                                    onClick={() => {
                                      const newCond: Filter = { column: '', op: '=', value: '', logic: 'AND', group: seg.groupId }
                                      // Insert after the last index of this group
                                      const lastIdx = Math.max(...seg.indices)
                                      setFilters(prev => {
                                        const n = [...prev]
                                        n.splice(lastIdx + 1, 0, newCond)
                                        return n
                                      })
                                    }}
                                    className={`self-start text-xs px-2 py-0.5 rounded border ${dark ? 'border-[#3e3e42] hover:bg-[#3e3e42] text-gray-300' : 'border-gray-300 hover:bg-gray-100 text-gray-600'}`}
                                  >+ 括号内添加条件</button>
                                  <span className={`text-xs ${dark ? 'text-gray-400' : 'text-gray-500'}`}>)</span>
                                </div>
                              </div>
                            )
                          }
                        })}
                      </div>
                    )
                  })()}
                </div>

                {/* Table */}
                <div ref={tableBodyRef} onScroll={() => handleVirtualScroll(false)} className="flex-1 overflow-auto scrollbar-thin">
                  {loading ? (
                    <div className={`flex items-center justify-center h-full ${textSub}`}>加载中...</div>
                  ) : (data.length > 0 || newRow !== null) ? (
                    <table className="text-sm border-collapse" style={{ tableLayout: 'fixed', width: '100%' }}>
                      <thead className={`sticky top-0 z-[30] ${bg2}`}>
                        <tr>
                          <th
                            style={{ width: 36, minWidth: 36, maxWidth: 36 }}
                            className={`sticky left-0 z-[31] border-b border-r ${border} ${dark ? 'bg-[#2a2a2a]' : 'bg-gray-100'} cursor-pointer`}
                            onClick={() => {
                              navigator.clipboard.writeText(selectedTable)
                              showToast(`表名 ${selectedTable} 已复制`)
                            }}
                          />
                          {(() => {
                            const commentMap: Record<string, string> = {}
                            structure.forEach(s => { if (s.Comment) commentMap[s.Field] = s.Comment })
                            return columns.map(col => {
                              const comment = commentMap[col]
                              return (
                                <th
                                  key={col}
                                  onMouseEnter={comment ? e => setHeaderTooltip({ text: `${col}: ${comment}`, x: e.clientX, y: e.clientY }) : undefined}
                                  onMouseMove={comment ? e => setHeaderTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null) : undefined}
                                  onMouseLeave={comment ? () => setHeaderTooltip(null) : undefined}
                                  style={{ width: getDataColumnWidth(col), minWidth: getColumnMinWidth(col), maxWidth: 800, overflow: 'hidden' }}
                                  className={`px-3 pt-1.5 pb-1 text-left border-b border-r ${border} font-medium relative group cursor-pointer`}
                                  onClick={e => {
                                    const target = e.target as HTMLElement
                                    if (!target.closest('button') && !target.classList.contains('cursor-col-resize')) {
                                      navigator.clipboard.writeText(col)
                                      showToast(`字段名 ${col} 已复制`)
                                    }
                                  }}
                                  onContextMenu={e => {
                                    e.preventDefault()
                                    setHeaderTooltip(null)
                                    setHeaderContextMenu({ x: e.clientX, y: e.clientY, col, comment: comment || '', isQuery: false })
                                  }}
                                >
                                  <div className="flex items-center justify-between min-w-0">
                                    <span className="truncate">{col}</span>
                                    <div className="flex gap-1 ml-1 flex-shrink-0">
                                      <button onClick={e => { e.stopPropagation(); handleSort(col) }} className={`text-xs ${sortColumn === col && sortOrder === 'ASC' ? 'text-blue-500' : textSub}`}>▲</button>
                                      <button onClick={e => { e.stopPropagation(); handleSort(col) }} className={`text-xs ${sortColumn === col && sortOrder === 'DESC' ? 'text-blue-500' : textSub}`}>▼</button>
                                    </div>
                                  </div>
                                  {comment && (
                                    <div className={`text-xs truncate ${textSub} font-normal`} style={{ maxWidth: (getDataColumnWidth(col)) - 16 }}>({comment})</div>
                                  )}
                                  <div onMouseDown={e => startResize(col, e)} className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500 opacity-0 group-hover:opacity-100" />
                                </th>
                              )
                            })
                          })()}
                          <th className={`border-b ${border}`} style={{ width: 'auto' }} />
                        </tr>
                      </thead>
                      <tbody>
                        {dataVirtualRange.topPadding > 0 && (
                          <tr aria-hidden="true">
                            <td colSpan={columns.length + 2} style={{ height: dataVirtualRange.topPadding, padding: 0, border: 0 }} />
                          </tr>
                        )}
                        {data.slice(dataVirtualRange.startIndex, dataVirtualRange.endIndex).map((row, offset) => {
                          const i = dataVirtualRange.startIndex + offset
                          const isRowSelected = selectedRows.has(i)
                          const bgClass = isRowSelected
                            ? 'bg-blue-600 text-white'
                            : i % 2 === 0 ? '' : (dark ? 'bg-[#2a2d2e]' : 'bg-blue-50')
                          return (
                            <tr key={i} data-row-index={i} className={`border-b ${border} ${bgClass} ${!isRowSelected ? hover : ''}`}>
                              <td
                                style={{ width: 36, minWidth: 36, maxWidth: 36 }}
                                onMouseDown={e => handleRowMouseDown(i, e, false)}
                                onMouseEnter={() => handleRowMouseEnter(i, false)}
                                onMouseUp={() => handleRowMouseUp(false)}
                                onClick={e => { e.stopPropagation(); rowSelectionActive.current = false }}
                                onContextMenu={e => { e.preventDefault(); setSelectedRows(new Set([i])); setContextMenu({ x: e.clientX, y: e.clientY, rowIndex: i }) }}
                                className={`sticky left-0 z-[15] border-r ${border} cursor-pointer text-center text-xs select-none ${isRowSelected ? '!bg-blue-700 !text-white' : (dark ? 'bg-[#2a2a2a] text-gray-500' : 'bg-gray-100 text-gray-400')}`}
                              >{i + 1}</td>
                              {columns.map(col => {
                                const edited = edits.get(i)?.[col]
                                const displayValue = edited !== undefined ? formatValue(edited) : formatValue(row[col])
                                const cellBg = edited !== undefined
                                  ? 'bg-yellow-200 text-black'
                                  : isRowSelected
                                    ? 'bg-blue-600 text-white'
                                    : i % 2 === 0 ? bg : (dark ? 'bg-[#2a2d2e]' : 'bg-blue-50')
                                return (
                                  <td
                                    key={col}
                                    style={{ width: getDataColumnWidth(col) }}
                                    className={`px-0 py-0 border-r ${border} relative`}
                                    onMouseDown={e => handleColCellMouseDown(i, col, e, false)}
                                    onMouseEnter={() => { handleColCellMouseEnter(i, col, false); setHoveredCell({ row: i, col, isQuery: false }) }}
                                    onMouseLeave={() => { handleColCellMouseUp(col, false); setHoveredCell(null); if (cellTooltipTimer.current) clearTimeout(cellTooltipTimer.current); setCellTooltip(null) }}
                                    onMouseUp={() => handleColCellMouseUp(col, false)}
                                  >
                                    <input
                                      type="text"
                                      value={displayValue}
                                      onChange={e => handleBulkColEdit(i, col, e.target.value || null, false)}
                                      onMouseEnter={e => {
                                        const val = formatValue(row[col])
                                        if (!val) return
                                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                        if (cellTooltipTimer.current) clearTimeout(cellTooltipTimer.current)
                                        cellTooltipTimer.current = setTimeout(() => setCellTooltip({ text: val, x: rect.left, y: rect.bottom + 4 }), 500)
                                      }}
                                      onMouseLeave={() => { if (cellTooltipTimer.current) clearTimeout(cellTooltipTimer.current); setCellTooltip(null) }}
                                      onClick={() => setCellTooltip(null)}
                                      className={`w-full px-3 py-1.5 border-none outline-none ${cellBg}`}
                                    />
                                    {hoveredCell?.row === i && hoveredCell?.col === col && !hoveredCell?.isQuery && (
                                      <button
                                        onMouseDown={e => { e.stopPropagation(); navigator.clipboard.writeText(formatValue(row[col])); setCellTooltip(null); setHoveredCell(null); showToast('复制成功') }}
                                        className={`absolute right-1 top-1/2 -translate-y-1/2 text-xs px-1.5 py-0.5 rounded z-10 ${dark ? 'bg-[#3e3e42] text-gray-300 hover:bg-[#555]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'} border ${border} shadow-sm`}
                                      >复制</button>
                                    )}
                                  </td>
                                )
                              })}
                              <td />
                            </tr>
                          )
                        })}
                        {dataVirtualRange.bottomPadding > 0 && (
                          <tr aria-hidden="true">
                            <td colSpan={columns.length + 2} style={{ height: dataVirtualRange.bottomPadding, padding: 0, border: 0 }} />
                          </tr>
                        )}
                        {newRow !== null && (
                          <tr className={`border-b ${border} ${dark ? 'bg-[#1a2a1a]' : 'bg-green-50'}`}>
                            <td style={{ width: 36, minWidth: 36, maxWidth: 36 }} className={`sticky left-0 z-[15] border-r ${border} text-center text-xs select-none ${dark ? 'bg-[#2a2a2a] text-green-400' : 'bg-gray-100 text-green-600'}`}>*</td>
                            {columns.map(col => (
                              <td key={col} style={{ width: getDataColumnWidth(col) }} className={`px-0 py-0 border-r ${border}`}>
                                <input
                                  type="text"
                                  value={newRow[col] ?? ''}
                                  placeholder={col}
                                  onChange={e => setNewRow({ ...newRow, [col]: e.target.value })}
                                  className={`w-full px-3 py-1.5 border-none outline-none ${dark ? 'bg-[#1a2a1a] text-green-300' : 'bg-green-50 text-green-800'}`}
                                />
                              </td>
                            ))}
                            <td />
                          </tr>
                        )}
                      </tbody>
                    </table>
                  ) : (
                    <div className={`flex items-center justify-center h-full ${textSub}`}>无数据</div>
                  )}
                </div>

                {/* Toolbar */}
                {renderToolbar({
                  hasEdits: edits.size > 0,
                  hasNewRow: newRow !== null,
                  hasSelected: selectedRows.size > 0,
                  onAdd: addNewRow,
                  onDelete: () => setDeleteConfirm({ rows: new Set(selectedRows), isQuery: false }),
                  onSubmit: submitEdits,
                  onDiscard: discardEdits,
                  onRefresh: () => loadTableData(page),
                  page: isNaN(page) ? 1 : page,
                  totalPages,
                  onFirst: () => { needsReload.current = true; setPage(1) },
                  onPrev: () => { needsReload.current = true; setPage(p => Math.max(1, isNaN(p) ? 1 : p - 1)) },
                  onNext: () => { needsReload.current = true; setPage(p => Math.min(totalPages, (isNaN(p) ? 0 : p) + 1)) },
                  onLast: () => { needsReload.current = true; setPage(totalPages) },
                  pageSizeVal: pageSizeText,
                  onPageSizeChange: setPageSizeText,
                  onPageSizeCommit: v => {
                    const n = parseInt(v)
                    if (v !== '' && Number.isFinite(n) && n > 0) {
                      setPageSizeText(String(n))
                      if (n !== pageSize) {
                        needsReload.current = true
                        setPageSize(n)
                        setPage(1)
                      }
                    } else {
                      setPageSizeText(String(pageSize))
                    }
                  },
                  totalCount: Number(total),
                  showDdlPreview: true,
                  pageSizeMenuKey: 'data',
                })}
            </div>

            {/* Structure Tab */}
            {activeTab === 'structure' && (
              <div className="flex-1 overflow-auto scrollbar-thin p-4">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className={bg2}>
                      {['字段', '类型', 'NULL', '键', '默认值', '额外', '注释'].map(h => (
                        <th key={h} className={`px-3 py-2 text-left border ${border}`}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {structure.map((col, i) => (
                      <tr key={i} className={hover}>
                        <td className={`px-3 py-2 border ${border}`}>{col.Field}</td>
                        <td className={`px-3 py-2 border ${border}`}>{col.Type}</td>
                        <td className={`px-3 py-2 border ${border}`}>{col.Null}</td>
                        <td className={`px-3 py-2 border ${border}`}>{col.Key}</td>
                        <td className={`px-3 py-2 border ${border}`}>{col.Default ?? 'NULL'}</td>
                        <td className={`px-3 py-2 border ${border}`}>{col.Extra}</td>
                        <td className={`px-3 py-2 border ${border}`}>{col.Comment}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* DDL Tab */}
            {activeTab === 'ddl' && (
              <div className="flex-1 overflow-auto scrollbar-thin p-4">
                <style>{`
                  .sql-keyword { color: #569cd6; font-weight: 500; }
                  .sql-string { color: #ce9178; }
                  .sql-number { color: #b5cea8; }
                  .sql-comment { color: #6a9955; }
                `}</style>
                <div className="flex justify-end mb-2">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(ddl)
                      showToast('DDL 已复制')
                    }}
                    disabled={!ddl}
                    className={`px-3 py-1.5 rounded-xl text-sm border disabled:opacity-50 disabled:cursor-not-allowed ${dark ? 'border-[#3e3e42] hover:bg-[#3e3e42]' : 'border-gray-300 hover:bg-gray-100'}`}
                  >复制 DDL</button>
                </div>
                <pre
                  className={`${bg} p-4 rounded border ${border} text-sm font-mono whitespace-pre-wrap`}
                  dangerouslySetInnerHTML={{ __html: highlightSQL(ddl) }}
                />
              </div>
            )}

            {/* Query Tab */}
            {activeTab === 'query' && (() => {
              const allTableNames = [...new Set([
                ...dbTabTables.flatMap(d => d.list),
                ...tabs.filter(t => t.table).map(t => t.table!)
              ])]
              sqlCompletionSourcesRef.current = [...SQL_COMPLETION_KEYWORDS, ...allTableNames, ...allColumns]

              const startQueryPanelResize = (e: React.MouseEvent) => {
                const startY = e.clientY, startH = queryPanelHeight
                const onMove = (ev: MouseEvent) => setQueryPanelHeight(Math.min(600, Math.max(80, startH + ev.clientY - startY)))
                const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }

              const queryTotalPages = Math.ceil(queryResultTotal / queryPageSize)
              const queryCols = queryResultData[0] ? Object.keys(queryResultData[0]) : []

              return (
                <div className="flex-1 flex flex-col overflow-hidden">
                  <div className={`border-b ${border} p-3 relative`}>
                    <div
                      className={`flex border ${border} rounded overflow-hidden focus-within:border-blue-500`}
                      style={{ height: queryPanelHeight }}
                    >
                      <div ref={sqlContainerRef} className="relative flex-1 min-w-0" />
                    </div>
                    <button onClick={() => executeQuery()} disabled={loading} className="mt-2 px-5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm disabled:opacity-50">
                      {loading ? '执行中...' : '▶ 执行'}
                    </button>
                  </div>
                  <div
                    className={`relative h-3 cursor-row-resize group flex items-center justify-center ${dark ? 'bg-[#3e3e42] hover:bg-blue-500/70' : 'bg-gray-200 hover:bg-blue-400/70'} transition-colors`}
                    onMouseDown={startQueryPanelResize}
                    title="上下拖动调整查询区和结果区高度"
                  >
                    <div className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-2.5 py-0.5 rounded-full border shadow-sm text-[10px] leading-none select-none transition-all group-hover:scale-105 ${dark ? 'bg-[#252526]/95 border-[#555] text-gray-300 group-hover:text-white group-hover:border-blue-400' : 'bg-white/95 border-gray-300 text-gray-500 group-hover:text-blue-600 group-hover:border-blue-300'}`}>
                      ↕︎
                    </div>
                  </div>
                  {queryResult?.success && queryResult.affectedRows !== undefined ? (
                    <div className="p-4 text-sm text-green-600">执行成功，影响 {queryResult.affectedRows} 行</div>
                  ) : queryResult?.error ? (
                    <div className="m-4 bg-red-100 border border-red-400 text-red-700 p-3 rounded-xl text-sm">{queryResult.error}</div>
                  ) : queryResult?.success && Array.isArray(queryResult.data) ? (
                    <>
                      <div ref={queryTableBodyRef} onScroll={() => handleVirtualScroll(true)} className="flex-1 overflow-auto scrollbar-thin">
                        {loading ? (
                          <div className={`flex items-center justify-center h-full ${textSub}`}>加载中...</div>
                        ) : (queryResultData.length > 0 || queryNewRow !== null) ? (
                          (() => {
                            const queryCols = queryResultData[0] ? Object.keys(queryResultData[0]) : []
                            const hasIdInResult = queryResultData.length > 0 && queryResultData.some(row => 'id' in row)
                            return (
                          <table className="text-sm border-collapse" style={{ tableLayout: 'fixed', width: '100%' }}>
                            <thead className={`sticky top-0 z-[30] ${bg2}`}>
                              <tr>
                                <th
                                  style={{ width: 36, minWidth: 36, maxWidth: 36 }}
                                  className={`sticky left-0 z-[31] border-b border-r ${border} ${dark ? 'bg-[#2a2a2a]' : 'bg-gray-100'} cursor-pointer`}
                                  onClick={() => {
                                    const tableName = selectedTable || 'table'
                                    navigator.clipboard.writeText(tableName)
                                    showToast(`表名 ${tableName} 已复制`)
                                  }}
                                />
                                {(() => {
                                  const commentMap: Record<string, string> = {}
                                  structure.forEach(s => { if (s.Comment) commentMap[s.Field] = s.Comment })
                                  return queryCols.map(col => {
                                    const comment = commentMap[col]
                                    return (
                                      <th
                                        key={col}
                                              onMouseEnter={comment ? e => setHeaderTooltip({ text: `${col}: ${comment}`, x: e.clientX, y: e.clientY }) : undefined}
                                        onMouseMove={comment ? e => setHeaderTooltip(t => t ? { ...t, x: e.clientX, y: e.clientY } : null) : undefined}
                                        onMouseLeave={comment ? () => setHeaderTooltip(null) : undefined}
                                        style={{ width: getQueryColumnWidth(col), minWidth: getColumnMinWidth(col), maxWidth: 800, overflow: 'hidden' }}
                                        className={`px-3 pt-1.5 pb-1 text-left border-b border-r ${border} font-medium relative group cursor-pointer`}
                                        onClick={e => {
                                          const target = e.target as HTMLElement
                                          if (!target.closest('button') && !target.classList.contains('cursor-col-resize')) {
                                            navigator.clipboard.writeText(col)
                                            showToast(`字段名 ${col} 已复制`)
                                          }
                                        }}
                                        onContextMenu={e => {
                                          e.preventDefault()
                                          setHeaderTooltip(null)
                                          setHeaderContextMenu({ x: e.clientX, y: e.clientY, col, comment: comment || '', isQuery: true })
                                        }}
                                      >
                                        <div className="flex items-center justify-between min-w-0">
                                          <span className="truncate">{col}</span>
                                          <div className="flex gap-1 ml-1 flex-shrink-0">
                                            <button onClick={e => { e.stopPropagation(); handleQuerySort(col) }} className={`text-xs ${querySortColumn === col && querySortOrder === 'ASC' ? 'text-blue-500' : textSub}`}>▲</button>
                                            <button onClick={e => { e.stopPropagation(); handleQuerySort(col) }} className={`text-xs ${querySortColumn === col && querySortOrder === 'DESC' ? 'text-blue-500' : textSub}`}>▼</button>
                                          </div>
                                        </div>
                                        {comment && (
                                          <div className={`text-xs truncate ${textSub} font-normal`} style={{ maxWidth: (getQueryColumnWidth(col)) - 16 }}>({comment})</div>
                                        )}
                                        <div onMouseDown={e => startQueryResize(col, e)} className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-blue-500 opacity-0 group-hover:opacity-100" />
                                      </th>
                                    )
                                  })
                                })()}
                                <th className={`border-b ${border}`} style={{ width: 'auto' }} />
                              </tr>
                            </thead>
                            <tbody>
                              {queryVirtualRange.topPadding > 0 && (
                                <tr aria-hidden="true">
                                  <td colSpan={queryCols.length + 2} style={{ height: queryVirtualRange.topPadding, padding: 0, border: 0 }} />
                                </tr>
                              )}
                              {queryResultData.slice(queryVirtualRange.startIndex, queryVirtualRange.endIndex).map((row, offset) => {
                                const i = queryVirtualRange.startIndex + offset
                                const hasId = 'id' in row
                                const isRowSelected = querySelectedRows.has(i)
                                const bgClass = isRowSelected ? 'bg-blue-600 text-white' : i % 2 === 0 ? '' : (dark ? 'bg-[#2a2d2e]' : 'bg-blue-50')
                                return (
                                  <tr key={i} data-row-index={i} className={`border-b ${border} ${bgClass} ${!isRowSelected ? hover : ''}`}>
                                    <td
                                      style={{ width: 36, minWidth: 36, maxWidth: 36 }}
                                      onMouseDown={e => handleRowMouseDown(i, e, true)}
                                      onMouseEnter={() => handleRowMouseEnter(i, true)}
                                      onMouseUp={() => handleRowMouseUp(true)}
                                      onClick={e => { e.stopPropagation(); rowSelectionActive.current = false }}
                                      onContextMenu={e => { e.preventDefault(); setQuerySelectedRows(new Set([i])); setQueryContextMenu({ x: e.clientX, y: e.clientY, rowIndex: i }) }}
                                      className={`sticky left-0 z-[15] border-r ${border} cursor-pointer text-center text-xs select-none ${isRowSelected ? '!bg-blue-700 !text-white' : (dark ? 'bg-[#2a2a2a] text-gray-500' : 'bg-gray-100 text-gray-400')}`}
                                    >
                                      {(queryPage - 1) * queryPageSize + i + 1}
                                    </td>
                                    {queryCols.map(col => {
                                      const edited = queryEdits.get(i)?.[col]
                                      const displayValue = edited !== undefined ? formatValue(edited) : formatValue(row[col])
                                      const cellBg = edited !== undefined
                                        ? 'bg-yellow-200 text-black'
                                        : isRowSelected
                                          ? 'bg-blue-600 text-white'
                                          : i % 2 === 0 ? bg : (dark ? 'bg-[#2a2d2e]' : 'bg-blue-50')
                                      return (
                                        <td
                                          key={col}
                                          style={{ width: getQueryColumnWidth(col) }}
                                          className={`px-0 py-0 border-r ${border} relative`}
                                          onMouseDown={e => handleColCellMouseDown(i, col, e, true)}
                                          onMouseEnter={() => { handleColCellMouseEnter(i, col, true); setHoveredCell({ row: i, col, isQuery: true }) }}
                                          onMouseLeave={() => { handleColCellMouseUp(col, true); setHoveredCell(null); if (cellTooltipTimer.current) clearTimeout(cellTooltipTimer.current); setCellTooltip(null) }}
                                          onMouseUp={() => handleColCellMouseUp(col, true)}
                                        >
                                          <input
                                            type="text"
                                            value={displayValue}
                                            onChange={e => hasId && handleBulkColEdit(i, col, e.target.value || null, true)}
                                            readOnly={!hasId}
                                            onMouseEnter={e => {
                                              const val = formatValue(row[col])
                                              if (!val) return
                                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                                              if (cellTooltipTimer.current) clearTimeout(cellTooltipTimer.current)
                                              cellTooltipTimer.current = setTimeout(() => setCellTooltip({ text: val, x: rect.left, y: rect.bottom + 4 }), 500)
                                            }}
                                            onMouseLeave={() => { if (cellTooltipTimer.current) clearTimeout(cellTooltipTimer.current); setCellTooltip(null) }}
                                            onClick={() => setCellTooltip(null)}
                                            className={`w-full px-3 py-1.5 border-none outline-none ${cellBg} ${!hasId ? 'cursor-default' : ''}`}
                                          />
                                          {hoveredCell?.row === i && hoveredCell?.col === col && hoveredCell?.isQuery && (
                                            <button
                                              onMouseDown={e => { e.stopPropagation(); navigator.clipboard.writeText(formatValue(row[col])); setCellTooltip(null); setHoveredCell(null); showToast('复制成功') }}
                                              className={`absolute right-1 top-1/2 -translate-y-1/2 text-xs px-1.5 py-0.5 rounded z-10 ${dark ? 'bg-[#3e3e42] text-gray-300 hover:bg-[#555]' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'} border ${border} shadow-sm`}
                                            >复制</button>
                                          )}
                                        </td>
                                      )
                                    })}
                                    <td />
                                  </tr>
                                )
                              })}
                              {queryVirtualRange.bottomPadding > 0 && (
                                <tr aria-hidden="true">
                                  <td colSpan={queryCols.length + 2} style={{ height: queryVirtualRange.bottomPadding, padding: 0, border: 0 }} />
                                </tr>
                              )}
                              {queryNewRow !== null && (
                                <tr className={`border-b ${border} ${dark ? 'bg-[#1a2a1a]' : 'bg-green-50'}`}>
                                  <td style={{ width: 36, minWidth: 36, maxWidth: 36 }} className={`sticky left-0 z-[15] border-r ${border} text-center text-xs select-none ${dark ? 'bg-[#2a2a2a] text-green-400' : 'bg-gray-100 text-green-600'}`}>*</td>
                                  {queryCols.map(col => (
                                    <td key={col} style={{ width: getQueryColumnWidth(col) }} className={`px-0 py-0 border-r ${border}`}>
                                      <input
                                        type="text"
                                        value={queryNewRow[col] ?? ''}
                                        placeholder={col}
                                        onChange={e => setQueryNewRow({ ...queryNewRow, [col]: e.target.value })}
                                        className={`w-full px-3 py-1.5 border-none outline-none ${dark ? 'bg-[#1a2a1a] text-green-300' : 'bg-green-50 text-green-800'}`}
                                      />
                                    </td>
                                  ))}
                                  <td />
                                </tr>
                              )}
                            </tbody>
                          </table>
                            )
                          })()
                        ) : (
                          <div className={`flex items-center justify-center h-full ${textSub}`}>无数据</div>
                        )}
                      </div>
                      {(() => {
                        const hasIdInResult = queryResultData.length > 0 && queryResultData.some(row => 'id' in row)
                        return renderToolbar({
                          hasEdits: queryEdits.size > 0,
                          hasNewRow: queryNewRow !== null,
                          hasSelected: hasIdInResult && querySelectedRows.size > 0,
                          onAdd: addQueryNewRow,
                          onDelete: hasIdInResult ? () => setDeleteConfirm({ rows: new Set(querySelectedRows), isQuery: true }) : undefined,
                          onSubmit: submitQueryEdits,
                          onDiscard: discardQueryEdits,
                          onRefresh: () => executeQuery(true),
                          page: queryPage,
                          totalPages: queryTotalPages,
                          onFirst: () => { setQueryPage(1); if (queryAutoLimit) executeQueryWithPage(1) },
                          onPrev: () => { const np = Math.max(1, queryPage - 1); setQueryPage(np); if (queryAutoLimit) executeQueryWithPage(np) },
                          onNext: () => { const np = Math.min(queryTotalPages, queryPage + 1); setQueryPage(np); if (queryAutoLimit) executeQueryWithPage(np) },
                          onLast: () => { setQueryPage(queryTotalPages); if (queryAutoLimit) executeQueryWithPage(queryTotalPages) },
                          pageSizeVal: queryPageSizeText,
                          onPageSizeChange: setQueryPageSizeText,
                          onPageSizeCommit: v => {
                            const n = parseInt(v)
                            if (v !== '' && Number.isFinite(n) && n > 0) {
                              setQueryPageSizeText(String(n))
                              if (n !== queryPageSize) {
                                setQueryPageSize(n)
                                setQueryPage(1)
                              }
                            } else {
                              setQueryPageSizeText(String(queryPageSize))
                            }
                          },
                          totalCount: queryResultTotal,
                          pageSizeMenuKey: 'query',
                        })
                      })()}
                    </>
                  ) : null}
                  {queryContextMenu && (() => {
                    const hasIdInResult = queryResultData.length > 0 && queryResultData.some(row => 'id' in row)
                    return (
                      <div
                        className={`fixed z-50 rounded border shadow-lg ${bg2} ${border}`}
                        style={{ top: queryContextMenu.y, left: queryContextMenu.x }}
                        onClick={e => e.stopPropagation()}
                      >
                        {hasIdInResult && <button onClick={() => copyQueryRowSQL(queryContextMenu.rowIndex)} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>复制 插入SQL</button>}
                        {hasIdInResult && <button onClick={() => copyQueryRowUpdateSQL(queryContextMenu.rowIndex)} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>复制 更新SQL</button>}
                        <button onClick={() => copyQueryRowJSON(queryContextMenu.rowIndex)} className={`w-full text-left px-4 py-2 text-sm ${hover}`}>复制 JSON</button>
                      </div>
                    )
                  })()}
                </div>
              )
            })()}

            {/* Log parser Tab */}
            {activeTab === 'logParser' && (
              <div className="flex-1 flex flex-col overflow-auto scrollbar-thin p-4 gap-3">
                <div>
                  <h3 className="font-semibold mb-1">日志语句解析</h3>
                  <p className={`text-sm ${textSub}`}>将阿里云日志中的 SQL 问号占位符和参数按顺序合并，生成可直接执行的 SQL。</p>
                </div>
                <div>
                  <div className={`text-xs mb-1 ${textSub}`}>SQL / 日志语句</div>
                  <textarea
                    value={logParserSql}
                    onChange={e => setLogParserSql(e.target.value)}
                    placeholder={LOG_PARSER_EXAMPLE_SQL}
                    className={`w-full h-56 font-mono resize-y ${inputCls}`}
                    spellCheck={false}
                  />
                </div>
                <div>
                  <div className={`text-xs mb-1 ${textSub}`}>参数</div>
                  <textarea
                    value={logParserParams}
                    onChange={e => setLogParserParams(e.target.value)}
                    placeholder={LOG_PARSER_EXAMPLE_PARAMS}
                    className={`w-full h-24 font-mono resize-y ${inputCls}`}
                    spellCheck={false}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={parseLogStatement} className={btnBlue}>解析</button>
                  <button onClick={clearLogParser} className={btnActive}>清空</button>
                  {logParserError && <span className="text-sm text-red-500">{logParserError}</span>}
                </div>
                <div className="flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <div className={`text-xs ${textSub}`}>解析结果</div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={runParsedLogSql}
                        disabled={!logParserOutput}
                        className={logParserOutput ? btnBlue : btnDisabled}
                      >运行</button>
                      <button
                        onClick={copyParsedLogSql}
                        disabled={!logParserOutput}
                        className={logParserOutput ? btnActive : btnDisabled}
                      >复制</button>
                    </div>
                  </div>
                  <textarea
                    value={logParserOutput}
                    readOnly
                    placeholder="解析后的 SQL 会显示在这里"
                    className={`h-48 font-mono resize-y ${inputCls}`}
                    spellCheck={false}
                  />
                </div>
              </div>
            )}

            {/* JSON beautify Tab */}
            {activeTab === 'jsonBeautify' && (
              <div className="flex-1 flex flex-col overflow-auto scrollbar-thin p-4 gap-3">
                <div>
                  <h3 className="font-semibold mb-1">JSON美化</h3>
                  <p className={`text-sm ${textSub}`}>输入 JSON 内容，格式化为易读的缩进结构。</p>
                </div>
                <div>
                  <div className={`text-xs mb-1 ${textSub}`}>JSON 输入</div>
                  <textarea
                    value={jsonBeautifyInput}
                    onChange={e => setJsonBeautifyInput(e.target.value)}
                    placeholder='例如：{"name":"hello","ids":[1207895,1207901]}'
                    className={`w-full h-48 font-mono resize-y ${inputCls}`}
                    spellCheck={false}
                  />
                  <div className="flex items-center gap-2 mt-2">
                    <button onClick={beautifyJson} className={btnBlue}>美化</button>
                    <button onClick={clearJsonBeautify} className={btnActive}>清空</button>
                    {jsonBeautifyError && <span className="text-sm text-red-500">{jsonBeautifyError}</span>}
                  </div>
                </div>
                <div className="flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center justify-between mb-1">
                    <div className={`text-xs ${textSub}`}>美化结果</div>
                    <button onClick={copyBeautifiedJson} disabled={!jsonBeautifyOutput} className={jsonBeautifyOutput ? btnActive : btnDisabled}>复制</button>
                  </div>
                  <textarea
                    value={jsonBeautifyOutput}
                    readOnly
                    placeholder="美化后的 JSON 会显示在这里"
                    className={`flex-1 min-h-64 font-mono resize-y ${inputCls}`}
                    spellCheck={false}
                  />
                </div>
              </div>
            )}
          </>
        ) : activeTabId && tabs.find(t => t.id === activeTabId)?.type === 'db' ? (
          <div className="p-6 overflow-auto">
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xl font-semibold">数据库: {tabs.find(t => t.id === activeTabId)?.label}</h2>
                <input
                  value={dbTabSearch}
                  onChange={e => setDbTabSearch(e.target.value)}
                  placeholder="搜索表名..."
                  className={`${inputCls} text-sm w-48`}
                />
              </div>
              <p className={`text-sm ${textSub}`}>点击表名打开表数据</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {(() => {
                const currentTab = tabs.find(t => t.id === activeTabId)
                const entry = dbTabTables.find(t => t.db === currentTab?.db)
                const list = entry?.list || []
                const filtered = dbTabSearch ? list.filter(t => t.toLowerCase().includes(dbTabSearch.toLowerCase())) : list
                return filtered.map(tbl => (
                  <button
                    key={tbl}
                    onClick={() => openTableTab(currentTab!.db, tbl)}
                    className={`flex items-center gap-2 px-4 py-3 rounded-2xl border shadow-sm transition-colors ${border} ${hover} text-left`}
                  >
                    <span className="text-blue-400">▤</span>
                    <span className="text-sm truncate">{tbl}</span>
                  </button>
                ))
              })()}
            </div>
          </div>
        ) : (
          <div className={`flex items-center justify-center h-full ${textSub}`}>选择一个表或数据库</div>
        )}
      </div>

      {/* Database filter modal */}
      {headerTooltip && (
        <div
          className={`fixed z-[9999] px-2 py-1 rounded-xl text-xs shadow-lg pointer-events-none ${dark ? 'bg-[#3c3c3c] text-white border border-[#555]' : 'bg-gray-800 text-white'}`}
          style={{ left: headerTooltip.x + 12, top: headerTooltip.y - 28 }}
        >
          {headerTooltip.text}
        </div>
      )}

      {/* Cell hover tooltip */}
      {cellTooltip && (
        <div
          className={`fixed z-[9998] px-3 py-2 rounded shadow-lg text-xs pointer-events-none max-w-xs ${dark ? 'bg-[#3c3c3c] text-white border border-[#555]' : 'bg-gray-800 text-white'}`}
          style={{ left: cellTooltip.x, top: cellTooltip.y }}
        >
          {cellTooltip.text.match(/.{1,40}/g)?.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] px-4 py-2 rounded-lg shadow-lg bg-gray-800 text-white text-sm"
        >
          {toast}
        </div>
      )}
    </div>
  )
}
