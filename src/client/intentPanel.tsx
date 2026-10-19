import { h } from 'preact'
import type { EdgeRow } from './types'
import { RowList } from './rows'
import { tr } from './i18n'

export function IntentPanel(props: { rows: EdgeRow[] }) {
  return h('section', { class: 'dsh-edge-panel' },
    h('h4', null, tr('panel.intent')),
    h(RowList, { rows: props.rows, panel: 'intent', empty: tr('row.empty') }),
  )
}
