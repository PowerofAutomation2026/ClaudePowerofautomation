import type { Backend } from '../types'
import { demoBackend } from './demo'
import { liveBackend } from './live'

/** True once `pac code add-data-source` has generated connector services (i.e. deployed build). */
export const hasConnectors = Object.keys(import.meta.glob('../../.power/schemas/appschemas/dataSourcesInfo.ts')).length > 0

export const pickBackend = (demo: boolean): Backend => (demo ? demoBackend : liveBackend)
