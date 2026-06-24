import { app, BrowserWindow, ipcMain } from 'electron'
import * as path from 'path'
import * as Module from 'module'

// Fix module resolution for both dev and packaged app
const appRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..')
;(Module as any).globalPaths.push(path.join(appRoot, 'node_modules'))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mysql = require('mysql2/promise')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Redis = require('ioredis')

const connections: Map<string, any> = new Map()
const connectionConfigs: Map<string, any> = new Map()

async function ensureMysqlConnection(id: string): Promise<any> {
  let conn = connections.get(id)
  if (!conn) return null
  try {
    await conn.ping()
    return conn
  } catch {
    // Connection dropped, reconnect using saved config
    try {
      const config = connectionConfigs.get(id)
      if (!config) return null
      const newConn = await mysql.createConnection(config)
      connections.set(id, newConn)
      return newConn
    } catch {
      return null
    }
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  if (!app.isPackaged) {
    win.loadURL('http://localhost:5173')
    win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())

// MySQL handlers
ipcMain.handle('mysql:connect', async (_, config) => {
  try {
    const conn = await mysql.createConnection(config)
    const id = `mysql_${Date.now()}`
    connections.set(id, conn)
    connectionConfigs.set(id, config)
    return { success: true, id }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('mysql:query', async (_, { id, sql }) => {
  try {
    const conn = await ensureMysqlConnection(id)
    if (!conn) return { success: false, error: 'Connection not found or failed to reconnect' }
    const [rows] = await conn.query(sql)
    const isResultSet = Array.isArray(rows)
    return { success: true, data: isResultSet ? rows : [], affectedRows: isResultSet ? undefined : (rows as any).affectedRows }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('mysql:databases', async (_, id) => {
  const conn = await ensureMysqlConnection(id)
  if (!conn) return []
  const [rows]: any = await conn.query('SHOW DATABASES')
  const systemDbs = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])
  return rows.map((r: any) => r.Database).filter((db: string) => !systemDbs.has(db))
})

ipcMain.handle('mysql:tables', async (_, { id, db }) => {
  const conn = await ensureMysqlConnection(id)
  if (!conn) return []
  const [rows]: any = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [db]
  )
  return rows.map((r: any) => r.TABLE_NAME)
})

ipcMain.handle('mysql:tableData', async (_, { id, db, table, page, pageSize }) => {
  try {
    const conn = await ensureMysqlConnection(id)
    if (!conn) return { success: false, error: 'Connection not found or failed to reconnect' }
    const offset = (page - 1) * pageSize
    const [rows]: any = await conn.query(`SELECT * FROM \`${db}\`.\`${table}\` LIMIT ${pageSize} OFFSET ${offset}`)
    const [countRows]: any = await conn.query(`SELECT COUNT(*) as total FROM \`${db}\`.\`${table}\``)
    const total = countRows[0].total
    return { success: true, data: rows, total }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('mysql:tableStructure', async (_, { id, db, table }) => {
  try {
    const conn = await ensureMysqlConnection(id)
    if (!conn) return { success: false, error: 'Connection not found or failed to reconnect' }
    const [columns]: any = await conn.query(`SHOW FULL COLUMNS FROM \`${db}\`.\`${table}\``)
    return { success: true, data: columns }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('mysql:tableDDL', async (_, { id, db, table }) => {
  try {
    const conn = await ensureMysqlConnection(id)
    if (!conn) return { success: false, error: 'Connection not found or failed to reconnect' }
    const [rows]: any = await conn.query(`SHOW CREATE TABLE \`${db}\`.\`${table}\``)
    return { success: true, ddl: rows[0]['Create Table'] }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('mysql:updateRow', async (_, { id, db, table, primaryKey, pkValue, updates }) => {
  try {
    const conn = await ensureMysqlConnection(id)
    if (!conn) return { success: false, error: 'Connection not found or failed to reconnect' }
    const setClauses = Object.entries(updates)
      .map(([col, val]) => `\`${col}\` = ${val === null ? 'NULL' : conn.escape(val)}`)
      .join(', ')
    const sql = `UPDATE \`${db}\`.\`${table}\` SET ${setClauses} WHERE \`${primaryKey}\` = ${conn.escape(pkValue)}`
    await conn.query(sql)
    return { success: true }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

// Redis handlers
ipcMain.handle('redis:connect', async (_, config) => {
  try {
    const client = new Redis(config)
    const id = `redis_${Date.now()}`
    connections.set(id, client)
    await client.ping()
    return { success: true, id }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('redis:command', async (_, { id, cmd, args }) => {
  try {
    const client = connections.get(id)
    const method = cmd.toLowerCase() as keyof typeof client
    if (typeof client[method] !== 'function') {
      return { success: false, error: `Unknown command: ${cmd}` }
    }
    const result = await (client[method] as Function)(...args)
    return { success: true, data: result }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
})

ipcMain.handle('redis:keys', async (_, { id, pattern }) => {
  const client = connections.get(id)
  return await client.keys(pattern || '*')
})

ipcMain.handle('disconnect', async (_, id) => {
  const conn = connections.get(id)
  if (conn) {
    if (conn.end) await conn.end()
    else if (conn.quit) await conn.quit()
    connections.delete(id)
    connectionConfigs.delete(id)
  }
})
