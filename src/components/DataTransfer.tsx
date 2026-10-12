import { useRef } from 'react'
import { exportLibraryData, importLibraryData, type LibraryBackup } from '../lib/storage'
import { copy, type UiLocale } from '../lib/i18n'
import '../data-transfer.css'

type DataTransferProps = { uiLocale: UiLocale; onNotice: (message: string) => void; onImported: () => void }

export default function DataTransfer({ uiLocale, onNotice, onImported }: DataTransferProps) {
  const ui = copy[uiLocale]
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
    onNotice(uiLocale === 'en' ? 'Reading data backup exported' : '阅读数据备份已导出')
  }

  async function importData(file: File) {
    try {
      const backup = JSON.parse(await file.text()) as LibraryBackup
      const result = await importLibraryData(backup)
      onImported()
      onNotice(uiLocale === 'en' ? `Restored ${result.books} books and ${result.highlights} highlights` : `已恢复 ${result.books} 本书和 ${result.highlights} 条摘录`)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : (uiLocale === 'en' ? 'Backup import failed' : '备份文件导入失败'))
    }
  }

  return <div className="data-transfer"><button onClick={() => { void exportData() }}>{ui.exportReading}</button><button onClick={() => inputRef.current?.click()}>{ui.importReading}</button><input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importData(file) }} /></div>
}
