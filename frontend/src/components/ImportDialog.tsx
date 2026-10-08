import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, XCircle } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { apiUpload, type ImportEntity, type ImportResult } from '../lib/api'
import { wsPath } from '../lib/data'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { cn } from '../lib/utils'
import { Modal } from './tour'
import { Button, ErrorText } from './ui'

/** Choose a file → preview what will happen row by row → import the valid rows. */
export function ImportDialog({ entity, tourId, onClose, onDone }: {
  entity: ImportEntity; tourId?: string; onClose: () => void; onDone: () => void
}) {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const send = async (f: File, commit: boolean) => {
    setBusy(true)
    setError(null)
    const q = new URLSearchParams({ commit: String(commit), mode })
    if (tourId) q.set('tour_id', tourId)
    try {
      const r = await apiUpload<ImportResult>(wsPath(ws.id, `/import/${entity}?${q}`), f)
      setResult(r)
      if (commit) onDone()
    } catch (e) {
      setError(e)
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const pick = (f: File | undefined) => {
    if (!f) return
    setFile(f)
    send(f, false)
  }

  const reset = () => { setFile(null); setResult(null); setError(null); if (input.current) input.current.value = '' }
  const previewKeys = result ? Object.values(result.columns).filter((v): v is string => !!v).slice(0, 7) : []

  return (
    <Modal wide title={t(`importTitle_${entity}`)} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{t('importHelp')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <a href={`/api${wsPath(ws.id, `/import/${entity}/template`)}`} download
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
            <Download size={16} />{t('downloadTemplate')}
          </a>
          {entity === 'participants' && (
            <select value={mode} onChange={(e) => { const m = e.target.value as 'append' | 'replace'; setMode(m) }}
              className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm">
              <option value="append">{t('importMode_append')}</option>
              <option value="replace">{t('importMode_replace')}</option>
            </select>
          )}
        </div>

        {!result?.committed && (
          <label className={cn('flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center',
            file ? 'border-brand-300 bg-brand-50/50' : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50')}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]) }}>
            <FileSpreadsheet size={28} className="text-brand-600" />
            <span className="font-medium">{file ? file.name : t('chooseFile')}</span>
            <span className="text-xs text-slate-500">.xlsx · .csv</span>
            <input ref={input} type="file" accept=".xlsx,.csv,.txt" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          </label>
        )}

        <ErrorText error={error} />

        {result && !result.committed && (
          <>
            {result.by_ai && <p className="rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">{t('importByAi')}</p>}
            <div className="flex flex-wrap gap-1.5 text-xs">
              <span className="py-1 font-semibold text-slate-500">{t('columns')}:</span>
              {Object.entries(result.columns).map(([h, k]) => (
                <span key={h} className={cn('rounded-md px-2 py-1', k ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-100 text-slate-400 line-through')}
                  title={k ?? t('ignored')}>
                  {h}{k && <span className="text-emerald-500"> → {k}</span>}
                </span>
              ))}
            </div>
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle2 size={18} className="text-emerald-600" />{t('rowsReady', { n: result.valid, total: result.total })}
            </p>
            <IssueList icon={<XCircle size={16} className="text-red-500" />} title={t('errors')} issues={result.errors} tone="red" />
            <IssueList icon={<AlertTriangle size={16} className="text-amber-500" />} title={t('warnings')} issues={result.warnings} tone="amber" />
            {result.preview.length > 0 && (
              <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-left text-slate-500">
                    <tr><th className="px-2 py-1.5">{t('row')}</th>{previewKeys.map((k) => <th key={k} className="px-2 py-1.5">{k}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {result.preview.slice(0, 50).map((r) => (
                      <tr key={String(r.row)}>
                        <td className="px-2 py-1 text-slate-400">{r.row}</td>
                        {previewKeys.map((k) => <td key={k} className="whitespace-nowrap px-2 py-1">{String(r[k] ?? '')}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={reset}>{t('cancel')}</Button>
              <Button disabled={busy || result.valid === 0} onClick={() => file && send(file, true)}>
                {t('importN', { n: result.valid })}
              </Button>
            </div>
          </>
        )}

        {result?.committed && (
          <div className="space-y-4">
            <p className="flex items-center gap-2 rounded-lg bg-emerald-50 px-4 py-3 font-medium text-emerald-800">
              <CheckCircle2 size={18} />{t('imported', { n: result.created })}
            </p>
            <IssueList icon={<XCircle size={16} className="text-red-500" />} title={t('errors')} issues={result.errors} tone="red" />
            <div className="flex justify-end gap-3">
              <Button variant="secondary" onClick={reset}>{t('another')}</Button>
              <Button onClick={onClose}>{t('done')}</Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function IssueList({ icon, title, issues, tone }: { icon: ReactNode; title: string; issues: { row: number; message: string }[]; tone: 'red' | 'amber' }) {
  const { t } = useI18n()
  if (!issues.length) return null
  return (
    <div className={cn('rounded-lg border px-3 py-2 text-sm', tone === 'red' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50')}>
      <p className="mb-1 flex items-center gap-2 font-semibold">{icon}{title} · {issues.length}</p>
      <ul className="max-h-32 space-y-0.5 overflow-auto text-slate-700">
        {issues.map((e, i) => <li key={i}><span className="text-slate-400">{t('row')} {e.row}:</span> {e.message}</li>)}
      </ul>
    </div>
  )
}
