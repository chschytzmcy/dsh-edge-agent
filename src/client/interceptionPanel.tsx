import { h } from 'preact'
import type { EdgeRow } from './types'
import { RowList } from './rows'
import { tr } from './i18n'

export function InterceptionPanel(props: { rows: EdgeRow[] }) {
  return h('section', { class: 'dsh-edge-panel' },
    h('h4', null, tr('panel.interception')),
    h(RowList, { rows: props.rows, panel: 'interception', empty: tr('row.empty') }),
  )
}
