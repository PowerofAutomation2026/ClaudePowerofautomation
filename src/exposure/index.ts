import { hasConnectors } from '../services'
import { demoExposure } from './demo'
import { liveExposure } from './live'
import type { ExposureBackend } from './types'

export { hasConnectors }
export const pickExposure = (demo: boolean): ExposureBackend => (demo ? demoExposure : liveExposure)
