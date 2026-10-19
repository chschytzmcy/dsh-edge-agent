import { h } from 'preact'
import type { EdgeRow } from './types'
import { RowList } from './rows'
import { tr } from './i18n'

export function ThreatPanel(props: { rows: EdgeRow[] }) {
  return h('section', { class: 'dsh-edge-panel' },
    h('h4', null, tr('panel.threat')),
    h(RowList, { rows: props.rows, panel: 'threat', empty: tr('row.empty') }),
  )
}
