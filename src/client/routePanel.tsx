import { createElement as h } from 'react'
import type { EdgeRow } from './types'
import { RowList } from './rows'
import { tr } from './i18n'

export function RoutePanel(props: { rows: EdgeRow[] }) {
  return h('section', { class: 'dsh-edge-panel' },
    h('h4', null, tr('panel.route')),
    h(RowList, { rows: props.rows, panel: 'route', empty: tr('row.empty') }),
  )
}
