import { useQueryClient } from '@tanstack/react-query'
import { Building2, Contact, Map as MapIcon, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ImportDialog } from '../components/ImportDialog'
import { Button, Card } from '../components/ui'
import { atLeast, type ImportEntity, type Role } from '../lib/api'
import { useI18n } from '../lib/i18n'
import { useWorkspace } from '../lib/session'
import { PageHeader } from './Dashboard'

const ENTITIES: { entity: ImportEntity; icon: ReactNode; minRole: Role }[] = [
  { entity: 'tours', icon: <MapIcon size={20} />, minRole: 'staff' },
  { entity: 'vendors', icon: <Building2 size={20} />, minRole: 'manager' },
  { entity: 'clients', icon: <Contact size={20} />, minRole: 'manager' },
]

export function ImportPage() {
  const ws = useWorkspace()!
  const { t } = useI18n()
  const qc = useQueryClient()
  const [open, setOpen] = useState<ImportEntity | null>(null)
  return (
    <>
      <PageHeader section="settings" title={t('settings')} subtitle={t('importPageHelp')} />
      <div className="grid max-w-4xl gap-4 p-4 sm:grid-cols-3 md:p-8">
        {ENTITIES.filter((e) => atLeast(ws.role, e.minRole)).map(({ entity, icon }) => (
          <Card key={entity} className="flex flex-col gap-4 p-5">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600">{icon}</span>
            <h2 className="font-semibold">{t(entity)}</h2>
            <Button variant="secondary" onClick={() => setOpen(entity)}><Upload size={16} />{t('import')}</Button>
          </Card>
        ))}
      </div>
      {open && (
        <ImportDialog entity={open} onClose={() => setOpen(null)}
          onDone={() => qc.invalidateQueries({ queryKey: [open, ws.id] })} />
      )}
    </>
  )
}
