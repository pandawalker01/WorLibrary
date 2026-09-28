import { useRef } from 'react'
import { exportLibraryData, importLibraryData, type LibraryBackup } from '../lib/storage'
import '../data-transfer.css'

type DataTransferProps = { onNotice: (message: string) => void; onImported: () => void }

export default function DataTransfer({ onNotice, onImported }: DataTransferProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  async function exportData() {
    const backup = await exportLibraryData()
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `wor-library-backup-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    onNotice('阅读数据备份已导出')
  }

  async function importData(file: File) {
    try {
      const backup = JSON.parse(await file.text()) as LibraryBackup
      const result = await importLibraryData(backup)
      onImported()
      onNotice(`已恢复 ${result.books} 本书和 ${result.highlights} 条摘录`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '备份文件导入失败')
    }
  }

  return <div className="data-transfer"><button onClick={() => { void exportData() }}>导出阅读数据</button><button onClick={() => inputRef.current?.click()}>导入阅读数据</button><input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importData(file) }} /></div>
}
