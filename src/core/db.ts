import type { StoredDrawing, StoredFile } from './types'

const DB_NAME = 'shoujicad'
const DB_VERSION = 1
const DRAWING_STORE = 'drawings'
const FILE_STORE = 'files'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(DRAWING_STORE)) db.createObjectStore(DRAWING_STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(FILE_STORE)) db.createObjectStore(FILE_STORE, { keyPath: 'id' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('无法打开本地数据库'))
    })
  }
  return dbPromise
}

function run<T>(store: string, mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const request = action(tx.objectStore(store))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('本地数据库操作失败'))
      })
  )
}

export function saveDrawing(drawing: StoredDrawing, file: ArrayBuffer): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([DRAWING_STORE, FILE_STORE], 'readwrite')
        tx.objectStore(DRAWING_STORE).put(drawing)
        tx.objectStore(FILE_STORE).put({ id: drawing.id, file } satisfies StoredFile)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('保存图纸失败'))
      })
  )
}

export function listDrawings(): Promise<StoredDrawing[]> {
  return run<StoredDrawing[]>(DRAWING_STORE, 'readonly', (s) => s.getAll())
}

export function getDrawing(id: string): Promise<StoredDrawing | undefined> {
  return run<StoredDrawing | undefined>(DRAWING_STORE, 'readonly', (s) => s.get(id))
}

export function getFile(id: string): Promise<StoredFile | undefined> {
  return run<StoredFile | undefined>(FILE_STORE, 'readonly', (s) => s.get(id))
}

export function deleteDrawing(id: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction([DRAWING_STORE, FILE_STORE], 'readwrite')
        tx.objectStore(DRAWING_STORE).delete(id)
        tx.objectStore(FILE_STORE).delete(id)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error ?? new Error('删除图纸失败'))
      })
  )
}
